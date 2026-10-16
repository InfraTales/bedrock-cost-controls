import type { Tier } from './config';
import type { Usage } from './pricing';

export const NAMESPACE = 'BedrockGateway';

/**
 * CloudWatch Embedded Metric Format: one JSON log line becomes metrics, with no
 * PutMetricData calls. Tier is the only dimension. Each extra dimension value is a
 * separate billed metric, so the user ID goes in as a plain field: you can still
 * query it in CloudWatch Logs Insights, but it doesn't create a metric per user.
 */
export function callRecord(input: {
  tier: Tier;
  modelId: string;
  userId: string;
  usage: Usage;
  costMicroUsd: number;
  stopReason: string;
  now: Date;
}): Record<string, unknown> {
  return {
    _aws: {
      Timestamp: input.now.getTime(),
      CloudWatchMetrics: [
        {
          Namespace: NAMESPACE,
          Dimensions: [['Tier']],
          Metrics: [
            { Name: 'InputTokens', Unit: 'Count' },
            { Name: 'OutputTokens', Unit: 'Count' },
            { Name: 'CacheReadTokens', Unit: 'Count' },
            { Name: 'CostMicroUsd', Unit: 'Count' },
          ],
        },
      ],
    },
    Tier: input.tier,
    InputTokens: input.usage.inputTokens + input.usage.cacheWriteInputTokens,
    OutputTokens: input.usage.outputTokens,
    CacheReadTokens: input.usage.cacheReadInputTokens,
    CostMicroUsd: input.costMicroUsd,
    modelId: input.modelId,
    userId: input.userId,
    stopReason: input.stopReason,
  };
}

/** One count per request the budget turned away. No dimensions: one metric in total. */
export function rejectedRecord(input: { userId: string; tier: Tier; now: Date }): Record<string, unknown> {
  return {
    _aws: {
      Timestamp: input.now.getTime(),
      CloudWatchMetrics: [{ Namespace: NAMESPACE, Dimensions: [[]], Metrics: [{ Name: 'BudgetRejected', Unit: 'Count' }] }],
    },
    BudgetRejected: 1,
    userId: input.userId,
    tier: input.tier,
  };
}
