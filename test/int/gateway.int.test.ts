/**
 * The real handler and the real budget store against DynamoDB Local. Only Bedrock is
 * stubbed, with aws-sdk-client-mock, because there's no local Bedrock engine.
 */
import { BedrockRuntimeClient, ConverseCommand, type ConverseCommandOutput } from '@aws-sdk/client-bedrock-runtime';
import { mockClient } from 'aws-sdk-client-mock';
import { BudgetStore } from '../../app/src/budget';
import { reservationMicroUsd, shouldCache } from '../../app/src/estimate';
import type { Deps } from '../../app/src/gateway';
import { defaultDeps, makeHandler, type UrlEvent } from '../../app/src/handler';
import { SYSTEM_PROMPT } from '../../app/src/system-prompt';
import { createTable, dropTable, localDynamo } from '../support/ddb';
import { fastModel, lambdaEnv, smartModel, testConfig } from '../support/env';

const { client, doc } = localDynamo();
const bedrock = mockClient(BedrockRuntimeClient);
let table: string;
let logs: Record<string, unknown>[];

beforeEach(async () => {
  table = await createTable(client);
  bedrock.reset();
  logs = [];
});
afterEach(async () => {
  await dropTable(client, table);
});

const NOW = new Date('2026-10-16T12:00:00Z');

function deps(limit: number): Deps {
  return {
    config: testConfig({ tableName: table, dailyBudgetMicroUsd: limit }),
    bedrock: new BedrockRuntimeClient({}),
    budget: new BudgetStore(doc, table, limit, () => NOW),
    systemPrompt: SYSTEM_PROMPT,
    log: (r) => logs.push(r),
    now: () => NOW,
  };
}

function post(body: unknown): UrlEvent {
  return { body: JSON.stringify(body), requestContext: { http: { method: 'POST' } } };
}

function reply(usage: Partial<NonNullable<ConverseCommandOutput['usage']>>, stopReason = 'end_turn'): Partial<ConverseCommandOutput> {
  return {
    output: { message: { role: 'assistant', content: [{ text: 'Go to Settings, then Members.' }] } },
    stopReason: stopReason as ConverseCommandOutput['stopReason'],
    usage: { inputTokens: 40, outputTokens: 60, totalTokens: 100, ...usage },
  };
}

const fastReserve = reservationMicroUsd(fastModel, SYSTEM_PROMPT, 'How do I change a role?', shouldCache(fastModel, SYSTEM_PROMPT));
const smartReserve = reservationMicroUsd(smartModel, SYSTEM_PROMPT, 'Plan a migration', shouldCache(smartModel, SYSTEM_PROMPT));

test('a call is charged its real cost, not the reservation', async () => {
  bedrock.on(ConverseCommand).resolves(reply({ inputTokens: 40, outputTokens: 60, cacheReadInputTokens: 1400 }));
  const d = deps(500_000);
  const res = await makeHandler(() => d)(post({ userId: 'u1', prompt: 'How do I change a role?' }));
  expect(res.statusCode).toBe(200);
  const body = JSON.parse(res.body);
  // Haiku 5.5 global: 40 x 0.1 + 60 x 0.5 + 1,400 x 0.01 = 4 + 30 + 14 = 48 micro-dollars.
  expect(body).toMatchObject({ tier: 'fast', downgraded: false, truncated: false, costMicroUsd: 48, remainingMicroUsd: 500_000 - 48 });
  expect(await d.budget.usedToday('u1')).toBe(48);

  const sent = bedrock.commandCalls(ConverseCommand)[0]!.args[0].input;
  expect(sent.modelId).toBe('global.anthropic.claude-haiku-5-5');
  expect(sent.inferenceConfig?.maxTokens).toBe(1024);
  expect(sent.system?.at(-1)).toEqual({ cachePoint: { type: 'default' } });
  expect(sent.additionalModelRequestFields).toEqual({ thinking: { type: 'disabled' } });

  const metric = logs.find((l) => '_aws' in l);
  expect(metric).toMatchObject({ Tier: 'fast', CostMicroUsd: 48, CacheReadTokens: 1400, userId: 'u1' });
});

test('an exhausted budget gets 429 and Bedrock is never called', async () => {
  const d = deps(fastReserve - 1);
  const res = await makeHandler(() => d)(post({ userId: 'u1', prompt: 'How do I change a role?' }));
  expect(res.statusCode).toBe(429);
  expect(JSON.parse(res.body).error).toBe('budget_exceeded');
  expect(bedrock.commandCalls(ConverseCommand)).toHaveLength(0);
  expect(logs).toContainEqual(expect.objectContaining({ BudgetRejected: 1, userId: 'u1' }));
});

test('a smart request the user cannot afford falls back to the fast model', async () => {
  bedrock.on(ConverseCommand).resolves(reply({}));
  // Enough for a fast call, not for a smart one.
  expect(fastReserve).toBeLessThan(smartReserve);
  const d = deps(fastReserve + 10);
  const res = await makeHandler(() => d)(post({ userId: 'u1', prompt: 'Plan a migration', task: 'planning' }));
  expect(res.statusCode).toBe(200);
  expect(JSON.parse(res.body)).toMatchObject({ tier: 'fast', downgraded: true });
  expect(bedrock.commandCalls(ConverseCommand)[0]!.args[0].input.modelId).toBe('global.anthropic.claude-haiku-5-5');
});

test('a smart request that fits uses Sonnet 5.5 with low-effort thinking', async () => {
  bedrock.on(ConverseCommand).resolves(reply({ inputTokens: 100, outputTokens: 900, cacheWriteInputTokens: 1400 }));
  const d = deps(500_000);
  const res = await makeHandler(() => d)(post({ userId: 'u1', prompt: 'Plan a migration', task: 'planning' }));
  const body = JSON.parse(res.body);
  // Sonnet 5.5 global: 100 x 2 + 900 x 10 + 1,400 x 2.5 = 200 + 9,000 + 3,500.
  expect(body).toMatchObject({ tier: 'smart', costMicroUsd: 12_700 });
  const sent = bedrock.commandCalls(ConverseCommand)[0]!.args[0].input;
  expect(sent.inferenceConfig?.maxTokens).toBe(2048);
  expect(sent.additionalModelRequestFields).toEqual({ thinking: { type: 'adaptive' }, output_config: { effort: 'low' } });
});

test('a throttled call returns 503 and gives the whole reservation back', async () => {
  bedrock.on(ConverseCommand).rejects(Object.assign(new Error('slow down'), { name: 'ThrottlingException' }));
  const d = deps(500_000);
  const res = await makeHandler(() => d)(post({ userId: 'u1', prompt: 'How do I change a role?' }));
  expect(res.statusCode).toBe(503);
  expect(await d.budget.usedToday('u1')).toBe(0);
});

test('any other model error returns 502 and gives the reservation back', async () => {
  bedrock.on(ConverseCommand).rejects(Object.assign(new Error('bad'), { name: 'ValidationException' }));
  const d = deps(500_000);
  const res = await makeHandler(() => d)(post({ userId: 'u1', prompt: 'How do I change a role?' }));
  expect(res.statusCode).toBe(502);
  expect(await d.budget.usedToday('u1')).toBe(0);
});

test('an answer cut off at maxTokens is flagged, and still charged', async () => {
  bedrock.on(ConverseCommand).resolves(reply({ outputTokens: 1024 }, 'max_tokens'));
  const d = deps(500_000);
  const body = JSON.parse((await makeHandler(() => d)(post({ userId: 'u1', prompt: 'Write a long answer' }))).body);
  expect(body.truncated).toBe(true);
  expect(body.costMicroUsd).toBe(Math.ceil(40 * 0.1 + 1024 * 0.5));
});

test('concurrent calls through the handler never spend past the limit', async () => {
  // Every call uses its full allowance: the worst case for the budget.
  bedrock.on(ConverseCommand).resolves(reply({ inputTokens: 2000, outputTokens: 1024, cacheWriteInputTokens: 1400 }));
  const limit = fastReserve * 5 + 7;
  const d = deps(limit);
  const handler = makeHandler(() => d);
  const results = await Promise.all(
    Array.from({ length: 25 }, () => handler(post({ userId: 'u1', prompt: 'How do I change a role?' }))),
  );
  const ok = results.filter((r) => r.statusCode === 200);
  expect(ok.length).toBeGreaterThanOrEqual(5);
  expect(results.filter((r) => r.statusCode === 429).length).toBe(25 - ok.length);
  const charged = ok.reduce((sum, r) => sum + (JSON.parse(r.body) as { costMicroUsd: number }).costMicroUsd, 0);
  expect(await d.budget.usedToday('u1')).toBe(charged);
  expect(charged).toBeLessThanOrEqual(limit);
});

test('the exported handler builds its clients from the environment', async () => {
  bedrock.on(ConverseCommand).resolves(reply({}));
  const env = { ...process.env, ...lambdaEnv, TABLE_NAME: table };
  const d = defaultDeps(env);
  const res = await makeHandler(() => d)(post({ userId: 'u9', prompt: 'hello' }));
  expect(res.statusCode).toBe(200);
  expect(await new BudgetStore(doc, table, 500_000).usedToday('u9')).toBeGreaterThan(0);
});
