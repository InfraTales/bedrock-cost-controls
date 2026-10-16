/**
 * After `npm run deploy`: sends two real requests through the deployed function and
 * checks the second one reads the system prompt from the cache. Costs a fraction of
 * a cent. Uses your AWS credentials and the stack's outputs.
 */
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';

const STACK = process.env.STACK_NAME ?? 'BedrockCostControls';

async function main(): Promise<void> {
  const cfn = new CloudFormationClient({});
  const stack = (await cfn.send(new DescribeStacksCommand({ StackName: STACK }))).Stacks?.[0];
  const fn = stack?.Outputs?.find((o) => o.OutputKey === 'FunctionName')?.OutputValue;
  if (!fn) throw new Error(`Stack ${STACK} has no FunctionName output. Deploy first.`);

  const lambda = new LambdaClient({});
  const call = async (prompt: string) => {
    const event = { body: JSON.stringify({ userId: 'smoke-test', prompt }), requestContext: { http: { method: 'POST' } } };
    const out = await lambda.send(new InvokeCommand({ FunctionName: fn, Payload: Buffer.from(JSON.stringify(event)) }));
    const res = JSON.parse(Buffer.from(out.Payload ?? []).toString()) as { statusCode: number; body: string };
    if (res.statusCode !== 200) throw new Error(`Expected 200, got ${res.statusCode}: ${res.body}`);
    return JSON.parse(res.body) as { tier: string; usage: Record<string, number>; costMicroUsd: number; remainingMicroUsd: number };
  };

  const first = await call('How do I change someone\'s role?');
  console.log('first ', first.tier, first.usage, `${first.costMicroUsd} micro-USD`);
  const second = await call('How long do paused runs stay open?');
  console.log('second', second.tier, second.usage, `${second.costMicroUsd} micro-USD`, `${second.remainingMicroUsd} left today`);
  if ((second.usage.cacheReadInputTokens ?? 0) === 0) {
    throw new Error('The second call read nothing from the cache. Check the system prompt length and the model minimum.');
  }
  console.log('OK: budget charged, cache read on the second call.');
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
