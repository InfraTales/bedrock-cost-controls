import { callRecord, NAMESPACE, rejectedRecord } from '../../app/src/metrics';

const now = new Date('2026-10-16T12:00:00Z');
const usage = { inputTokens: 40, outputTokens: 60, cacheReadInputTokens: 1400, cacheWriteInputTokens: 10 };

test('a call record is valid Embedded Metric Format with Tier as the only dimension', () => {
  const r = callRecord({ tier: 'fast', modelId: 'm', userId: 'u1', usage, costMicroUsd: 48, stopReason: 'end_turn', now }) as any;
  const directive = r._aws.CloudWatchMetrics[0];
  expect(r._aws.Timestamp).toBe(now.getTime());
  expect(directive.Namespace).toBe(NAMESPACE);
  expect(directive.Dimensions).toEqual([['Tier']]);
  // Every metric named in the directive has a numeric value on the record.
  for (const m of directive.Metrics) expect(typeof r[m.Name]).toBe('number');
  expect(r).toMatchObject({ Tier: 'fast', InputTokens: 50, OutputTokens: 60, CacheReadTokens: 1400, CostMicroUsd: 48 });
});

test('the user ID is a searchable field, never a dimension', () => {
  const r = callRecord({ tier: 'smart', modelId: 'm', userId: 'u1', usage, costMicroUsd: 1, stopReason: 'end_turn', now }) as any;
  expect(r.userId).toBe('u1');
  expect(JSON.stringify(r._aws)).not.toContain('userId');
});

test('a rejection is one dimensionless count', () => {
  const r = rejectedRecord({ userId: 'u1', tier: 'smart', now }) as any;
  expect(r._aws.CloudWatchMetrics[0].Dimensions).toEqual([[]]);
  expect(r.BudgetRejected).toBe(1);
});
