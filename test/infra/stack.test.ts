import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { AwsSolutionsChecks } from 'cdk-nag';
import { loadConfig } from '../../app/src/config';
import { BUNDLE_DIR, GatewayStack } from '../../infra/lib/gateway-stack';

const env = { account: '123456789012', region: 'us-east-1' };
const synth = (costTags: boolean) =>
  Template.fromStack(new GatewayStack(new cdk.App(), costTags ? 'Tagged' : 'Global', { env, alertEmail: 'ops@example.com', costTags }));
const global = synth(false);
const tagged = synth(true);

const only = (t: Template, type: string) => {
  const all = Object.values<any>(t.findResources(type));
  expect(all).toHaveLength(1);
  return all[0];
};
const statements = (t: Template): any[] => only(t, 'AWS::IAM::Policy').Properties.PolicyDocument.Statement;
const bedrockStatements = (t: Template) => statements(t).filter((s) => String(s.Action).startsWith('bedrock:'));
/** Renders an ARN built with Fn::Join, with the partition filled in, for readable checks. */
const arn = (value: any): string =>
  typeof value === 'string'
    ? value
    : value['Fn::Join'][1].map((part: any) => (typeof part === 'string' ? part : part.Ref === 'AWS::Partition' ? 'aws' : JSON.stringify(part))).join('');

test('the function runs Node.js 24 on arm64 with a bounded timeout', () => {
  global.hasResourceProperties('AWS::Lambda::Function', {
    Runtime: 'nodejs24.x',
    Architectures: ['arm64'],
    Handler: 'index.handler',
    Timeout: 90,
  });
});

test('the function URL requires SigV4-signed requests', () => {
  global.hasResourceProperties('AWS::Lambda::Url', { AuthType: 'AWS_IAM' });
});

test('the environment the stack sets is one the function can load', () => {
  for (const t of [global, tagged]) {
    const vars = only(t, 'AWS::Lambda::Function').Properties.Environment.Variables;
    // Tokens (table name, profile ARNs) become placeholder strings; the shape is what counts.
    const plain = Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, typeof v === 'string' ? v : 'token']));
    const config = loadConfig(plain);
    expect(config.models.fast.maxTokens).toBe(1024);
    expect(config.models.smart.maxTokens).toBe(2048);
    expect(config.dailyBudgetMicroUsd).toBe(500_000);
  }
});

test('global mode calls global profiles and prices them as global', () => {
  const vars = only(global, 'AWS::Lambda::Function').Properties.Environment.Variables;
  expect(vars).toMatchObject({
    FAST_MODEL_ID: 'global.anthropic.claude-haiku-5-5',
    FAST_PRICE_KEY: 'claude-haiku-5-5-global',
    SMART_MODEL_ID: 'global.anthropic.claude-sonnet-5-5',
    SMART_PRICE_KEY: 'claude-sonnet-5-5-global',
    FAST_THINKING: 'off',
  });
  global.resourceCountIs('AWS::Bedrock::ApplicationInferenceProfile', 0);
});

test('global mode grants InvokeModel on exactly the three ARNs global routing needs', () => {
  const s = bedrockStatements(global);
  expect(s).toHaveLength(6);
  for (const st of s) expect(st.Action).toBe('bedrock:InvokeModel');
  const resources = s.map((st) => arn(st.Resource)).sort();
  expect(resources).toEqual(
    [
      'arn:aws:bedrock:us-east-1:123456789012:inference-profile/global.anthropic.claude-haiku-5-5',
      'arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-haiku-5-5',
      'arn:aws:bedrock:::foundation-model/anthropic.claude-haiku-5-5',
      'arn:aws:bedrock:us-east-1:123456789012:inference-profile/global.anthropic.claude-sonnet-5-5',
      'arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-sonnet-5-5',
      'arn:aws:bedrock:::foundation-model/anthropic.claude-sonnet-5-5',
    ].sort(),
  );
  // The Region-less model ARN only works through our profile, with the "unspecified" Region.
  const globalModel = s.find((st) => arn(st.Resource) === 'arn:aws:bedrock:::foundation-model/anthropic.claude-sonnet-5-5');
  expect(globalModel.Condition.StringEquals['aws:RequestedRegion']).toBe('unspecified');
  expect(JSON.stringify(globalModel.Condition.StringEquals['bedrock:InferenceProfileArn'])).toContain('global.anthropic.claude-sonnet-5-5');
});

test('no statement grants bedrock:* or a model wildcard in global mode', () => {
  const text = JSON.stringify(statements(global));
  expect(text).not.toMatch(/bedrock:\*/);
  expect(text).not.toMatch(/foundation-model\/\*/);
  expect(text).not.toMatch(/"Resource":"\*"/);
});

test('cost-tag mode creates tagged application inference profiles copied from the US profiles', () => {
  const profiles = Object.values<any>(tagged.findResources('AWS::Bedrock::ApplicationInferenceProfile'));
  expect(profiles).toHaveLength(2);
  for (const p of profiles) {
    expect(JSON.stringify(p.Properties.ModelSource.CopyFrom)).toMatch(/inference-profile\/us\.anthropic\.claude-(haiku-5-5|sonnet-5)/);
    expect(p.Properties.Tags).toEqual(expect.arrayContaining([{ Key: 'app', Value: 'bedrock-gateway' }]));
  }
  const vars = only(tagged, 'AWS::Lambda::Function').Properties.Environment.Variables;
  expect(vars.FAST_MODEL_ID).toEqual({ 'Fn::GetAtt': [expect.stringMatching(/^fastProfile/), 'InferenceProfileArn'] });
  expect(vars.FAST_PRICE_KEY).toBe('claude-haiku-5-5-geo');
});

test('the role can update and read budget counters, and nothing else in DynamoDB', () => {
  const ddb = statements(global).filter((s) => JSON.stringify(s.Action).includes('dynamodb:'));
  expect(ddb).toHaveLength(1);
  expect([ddb[0].Action].flat().sort()).toEqual(['dynamodb:GetItem', 'dynamodb:UpdateItem']);
});

test('the counter table is on-demand with TTL on expiresAt', () => {
  global.hasResourceProperties('AWS::DynamoDB::GlobalTable', {
    BillingMode: 'PAY_PER_REQUEST',
    TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true },
    KeySchema: [
      { AttributeName: 'pk', KeyType: 'HASH' },
      { AttributeName: 'sk', KeyType: 'RANGE' },
    ],
  });
});

test('an hourly spend alarm adds both tiers and notifies the alert topic', () => {
  const alarm = only(global, 'AWS::CloudWatch::Alarm').Properties;
  expect(alarm.Threshold).toBe(2_000_000);
  expect(alarm.TreatMissingData).toBe('notBreaching');
  const expr = alarm.Metrics.find((m: any) => m.Expression);
  expect(expr.Expression).toBe('FILL(fast, 0) + FILL(smart, 0)');
  const stats = alarm.Metrics.filter((m: any) => m.MetricStat).map((m: any) => m.MetricStat);
  expect(stats.map((s: any) => s.Metric.Dimensions[0].Value).sort()).toEqual(['fast', 'smart']);
  for (const s of stats) expect(s).toMatchObject({ Stat: 'Sum', Period: 3600, Metric: { MetricName: 'CostMicroUsd', Namespace: 'BedrockGateway' } });
  expect(alarm.AlarmActions).toEqual([{ Ref: expect.stringMatching(/^Alerts/) }]);
  global.hasResourceProperties('AWS::SNS::Subscription', { Protocol: 'email', Endpoint: 'ops@example.com' });
});

test('a monthly budget warns at 80% actual and 100% forecast, for the whole account', () => {
  const budget = only(global, 'AWS::Budgets::Budget').Properties;
  expect(budget.Budget).toEqual({ BudgetType: 'COST', TimeUnit: 'MONTHLY', BudgetLimit: { Amount: 20, Unit: 'USD' } });
  expect(budget.NotificationsWithSubscribers.map((n: any) => [n.Notification.NotificationType, n.Notification.Threshold])).toEqual([
    ['ACTUAL', 80],
    ['FORECASTED', 100],
  ]);
});

test('logs are kept for a month', () => {
  global.hasResourceProperties('AWS::Logs::LogGroup', { RetentionInDays: 30 });
  global.hasResourceProperties('AWS::Lambda::Function', { LoggingConfig: { LogGroup: { Ref: Match.stringLikeRegexp('^GatewayLogs') } } });
});

test.each([false, true])('cdk-nag AWS Solutions finds nothing unacknowledged (costTags=%s)', (costTags) => {
  const app = new cdk.App({ outdir: fs.mkdtempSync(path.join(os.tmpdir(), 'cdk-nag-')) });
  new GatewayStack(app, 'Nag', { env, alertEmail: 'ops@example.com', costTags });
  cdk.Validations.of(app).addPlugins(new AwsSolutionsChecks(app));
  const assembly = app.synth();
  const report = JSON.parse(fs.readFileSync(path.join(assembly.directory, 'validation-report.json'), 'utf8'));
  for (const plugin of report.pluginReports) expect(plugin.violations).toEqual([]);
});

test('synth stops with a clear message when the bundle is missing', () => {
  const backup = `${BUNDLE_DIR}.bak-${process.pid}`;
  fs.renameSync(BUNDLE_DIR, backup);
  try {
    expect(() => new GatewayStack(new cdk.App(), 'NoBundle', { env, alertEmail: 'ops@example.com' })).toThrow('Run "npm run bundle" first');
  } finally {
    fs.renameSync(backup, BUNDLE_DIR);
  }
});

test('cdk.json carries no default alert email, so the guard in infra/bin/app.ts can work', () => {
  const cdkJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'cdk.json'), 'utf8'));
  expect(cdkJson.context).not.toHaveProperty('alertEmail');
});
