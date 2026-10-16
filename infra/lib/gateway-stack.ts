import * as fs from 'node:fs';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as bedrock from 'aws-cdk-lib/aws-bedrock';
import * as budgets from 'aws-cdk-lib/aws-budgets';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subs from 'aws-cdk-lib/aws-sns-subscriptions';
import type { Construct } from 'constructs';
import { NAMESPACE } from '../../app/src/metrics';

export const BUNDLE_DIR = path.join(__dirname, '..', '..', 'build', 'gateway');

/** The two tiers. Model IDs and limits are from each model's card in the Bedrock docs. */
export const TIERS = {
  fast: { model: 'anthropic.claude-haiku-5-5', price: 'claude-haiku-5-5', maxTokens: 1024, minCacheTokens: 512, thinking: 'off' },
  smart: { model: 'anthropic.claude-sonnet-5', price: 'claude-sonnet-5', maxTokens: 2048, minCacheTokens: 1024, thinking: 'low' },
} as const;

export interface GatewayStackProps extends cdk.StackProps {
  /** Email for the cost alarm and the monthly budget. */
  alertEmail: string;
  /** Each user's daily allowance in micro-dollars. 500,000 = $0.50. */
  dailyBudgetMicroUsd?: number;
  /** Alarm when the gateway spends more than this in one hour, in micro-dollars. */
  hourlyAlarmMicroUsd?: number;
  /** Account-wide monthly AWS Budgets limit in USD. */
  monthlyBudgetUsd?: number;
  /**
   * true: call application inference profiles that carry cost allocation tags. They
   * copy the US geographic profiles (us.*), which cost 10% more than global ones.
   * false: call the global profiles (global.*) directly, the cheapest option.
   */
  costTags?: boolean;
}

export class GatewayStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: GatewayStackProps) {
    super(scope, id, props);
    if (!fs.existsSync(path.join(BUNDLE_DIR, 'index.js'))) {
      throw new Error(`No bundle at ${BUNDLE_DIR}. Run "npm run bundle" first.`);
    }
    const costTags = props.costTags ?? false;

    // One item per user per day. TTL deletes counters a week after their day ends.
    const table = new dynamodb.TableV2(this, 'Budgets', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand(),
      timeToLiveAttribute: 'expiresAt',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const logGroup = new logs.LogGroup(this, 'GatewayLogs', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Our own role, so the function can write only to its own log group.
    const role = new iam.Role(this, 'GatewayRole', { assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com') });
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
        resources: [`${logGroup.logGroupArn}:log-stream:*`],
      }),
    );
    table.grant(role, 'dynamodb:UpdateItem', 'dynamodb:GetItem');

    const env: Record<string, string> = {
      TABLE_NAME: table.tableName,
      DAILY_BUDGET_MICRO_USD: String(props.dailyBudgetMicroUsd ?? 500_000),
    };
    for (const [tier, t] of Object.entries(TIERS)) {
      const prefix = tier.toUpperCase();
      const modelId = costTags ? this.taggedProfile(tier, t.model, role) : this.globalProfile(tier, t.model, role);
      Object.assign(env, {
        [`${prefix}_MODEL_ID`]: modelId,
        [`${prefix}_PRICE_KEY`]: `${t.price}-${costTags ? 'geo' : 'global'}`,
        [`${prefix}_MAX_TOKENS`]: String(t.maxTokens),
        [`${prefix}_MIN_CACHE_TOKENS`]: String(t.minCacheTokens),
        [`${prefix}_THINKING`]: t.thinking,
      });
    }

    const fn = new lambda.Function(this, 'Gateway', {
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(BUNDLE_DIR),
      memorySize: 256,
      // Sonnet 5 writing 2,048 tokens can take a while. The cap on output keeps it bounded.
      timeout: cdk.Duration.seconds(90),
      role,
      logGroup,
      environment: env,
    });

    // Callers sign requests with SigV4. Your backend authenticates the end user and
    // passes their ID; the gateway never sees passwords or tokens.
    const url = fn.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.AWS_IAM });

    // Alarm on spend we can see right now. AWS Budgets lags by hours.
    const topic = new sns.Topic(this, 'Alerts', { enforceSSL: true });
    topic.addSubscription(new subs.EmailSubscription(props.alertEmail));
    const hourly = (tier: string) =>
      new cloudwatch.Metric({
        namespace: NAMESPACE,
        metricName: 'CostMicroUsd',
        dimensionsMap: { Tier: tier },
        statistic: 'Sum',
        period: cdk.Duration.hours(1),
      });
    const alarm = new cloudwatch.Alarm(this, 'HourlySpendAlarm', {
      alarmDescription: 'Bedrock gateway spend in the last hour is above the limit (micro-dollars).',
      metric: new cloudwatch.MathExpression({
        expression: 'FILL(fast, 0) + FILL(smart, 0)',
        usingMetrics: { fast: hourly('fast'), smart: hourly('smart') },
        period: cdk.Duration.hours(1),
      }),
      threshold: props.hourlyAlarmMicroUsd ?? 2_000_000,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    alarm.addAlarmAction(new actions.SnsAction(topic));

    // The backstop: the whole account's monthly bill. Claude models bill through AWS
    // Marketplace, not under the Amazon Bedrock service, so we don't filter by service.
    new budgets.CfnBudget(this, 'MonthlyBudget', {
      budget: {
        budgetType: 'COST',
        timeUnit: 'MONTHLY',
        budgetLimit: { amount: props.monthlyBudgetUsd ?? 20, unit: 'USD' },
      },
      notificationsWithSubscribers: [
        { notification: { notificationType: 'ACTUAL', comparisonOperator: 'GREATER_THAN', threshold: 80, thresholdType: 'PERCENTAGE' }, subscribers: [{ subscriptionType: 'EMAIL', address: props.alertEmail }] },
        { notification: { notificationType: 'FORECASTED', comparisonOperator: 'GREATER_THAN', threshold: 100, thresholdType: 'PERCENTAGE' }, subscribers: [{ subscriptionType: 'EMAIL', address: props.alertEmail }] },
      ],
    });

    new cdk.CfnOutput(this, 'GatewayUrl', { value: url.url });
    new cdk.CfnOutput(this, 'TableName', { value: table.tableName });
    new cdk.CfnOutput(this, 'FunctionName', { value: fn.functionName });
    this.acknowledgeFindings({ role, topic, table, logGroup, costTags });
  }

  /**
   * Global cross-Region profile: the cheapest way to call the model. IAM needs three
   * ARNs, as the Bedrock docs list them: the profile in this Region, the model in this
   * Region, and the Region-less model ARN that global routing checks.
   */
  private globalProfile(tier: string, model: string, role: iam.Role): string {
    const profileId = `global.${model}`;
    const profileArn = `arn:${this.partition}:bedrock:${this.region}:${this.account}:inference-profile/${profileId}`;
    role.addToPolicy(new iam.PolicyStatement({ sid: `${tier}Profile`, actions: ['bedrock:InvokeModel'], resources: [profileArn] }));
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: `${tier}RegionalModel`,
        actions: ['bedrock:InvokeModel'],
        resources: [`arn:${this.partition}:bedrock:${this.region}::foundation-model/${model}`],
        conditions: { StringEquals: { 'bedrock:InferenceProfileArn': profileArn } },
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: `${tier}GlobalModel`,
        actions: ['bedrock:InvokeModel'],
        resources: [`arn:${this.partition}:bedrock:::foundation-model/${model}`],
        conditions: { StringEquals: { 'aws:RequestedRegion': 'unspecified', 'bedrock:InferenceProfileArn': profileArn } },
      }),
    );
    return profileId;
  }

  /**
   * Application inference profile: our own profile with tags that reach Cost Explorer
   * once you activate them as cost allocation tags. It copies the US geo profile.
   */
  private taggedProfile(tier: string, model: string, role: iam.Role): string {
    const source = `arn:${this.partition}:bedrock:${this.region}:${this.account}:inference-profile/us.${model}`;
    const profile = new bedrock.CfnApplicationInferenceProfile(this, `${tier}Profile`, {
      inferenceProfileName: `${this.stackName}-${tier}`,
      description: `Bedrock gateway ${tier} tier`,
      modelSource: { copyFrom: source },
      tags: [
        { key: 'app', value: 'bedrock-gateway' },
        { key: 'tier', value: tier },
      ],
    });
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: `${tier}AppProfile`,
        actions: ['bedrock:InvokeModel'],
        resources: [profile.attrInferenceProfileArn, source],
      }),
    );
    // The US profile routes to several Regions, and which ones depends on the source
    // Region, so the model ARN keeps a Region wildcard. It names one model only.
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: `${tier}ModelAnyUsRegion`,
        actions: ['bedrock:InvokeModel'],
        resources: [`arn:${this.partition}:bedrock:*::foundation-model/${model}`],
      }),
    );
    return profile.attrInferenceProfileArn;
  }

  /** Every cdk-nag finding we accept, scoped to its construct, each with its reason. */
  private acknowledgeFindings(f: { role: iam.Role; topic: sns.Topic; table: dynamodb.TableV2; logGroup: logs.LogGroup; costTags: boolean }): void {
    const { role, topic, table, logGroup, costTags } = f;
    const ack = (scope: Construct, id: string, reason: string) => cdk.Validations.of(scope).acknowledge({ id, reason });
    const policy = role.node.findChild('DefaultPolicy');
    ack(
      policy,
      `AwsSolutions::AwsSolutions-IAM5[Resource::<${this.getLogicalId(logGroup.node.defaultChild as cdk.CfnElement)}.Arn>:log-stream:*]`,
      'Lambda names its log streams at runtime. The wildcard is limited to streams in this function\'s own log group.',
    );
    if (costTags) {
      // cdk-nag prints the partition as written in the template: a token or "aws".
      const partition = cdk.Token.isUnresolved(this.partition) ? '<AWS::Partition>' : this.partition;
      for (const t of Object.values(TIERS)) {
        ack(
          policy,
          `AwsSolutions::AwsSolutions-IAM5[Resource::arn:${partition}:bedrock:*::foundation-model/${t.model}]`,
          'The US geo profile routes to Regions that depend on the source Region, so the Region is a wildcard. The ARN names one model.',
        );
      }
    }
    ack(
      topic,
      'AwsSolutions::AwsSolutions-SNS2',
      'The topic carries alarm state changes only, no user data. CloudWatch alarms cannot publish to a topic encrypted with the AWS managed SNS key.',
    );
    ack(
      table,
      'AwsSolutions::AwsSolutions-DDB3',
      'The table holds daily spend counters that expire within days. Losing them resets budgets; point-in-time recovery would cost more than it protects.',
    );
  }
}
