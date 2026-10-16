import type { GatewayConfig, ModelConfig } from '../../app/src/config';
import { PRICES } from '../../app/src/pricing';

export const fastModel: ModelConfig = {
  modelId: 'global.anthropic.claude-haiku-5-5',
  price: PRICES['claude-haiku-5-5-global'],
  maxTokens: 1024,
  minCacheTokens: 512,
  thinking: 'off',
};

export const smartModel: ModelConfig = {
  modelId: 'global.anthropic.claude-sonnet-5',
  price: PRICES['claude-sonnet-5-global'],
  maxTokens: 2048,
  minCacheTokens: 1024,
  thinking: 'low',
};

export function testConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return { tableName: 'unused', dailyBudgetMicroUsd: 500_000, models: { fast: fastModel, smart: smartModel }, ...overrides };
}

/** The environment the stack gives the function, for config and handler tests. */
export const lambdaEnv: NodeJS.ProcessEnv = {
  TABLE_NAME: 'budgets',
  DAILY_BUDGET_MICRO_USD: '500000',
  FAST_MODEL_ID: 'global.anthropic.claude-haiku-5-5',
  FAST_PRICE_KEY: 'claude-haiku-5-5-global',
  FAST_MAX_TOKENS: '1024',
  FAST_MIN_CACHE_TOKENS: '512',
  FAST_THINKING: 'off',
  SMART_MODEL_ID: 'global.anthropic.claude-sonnet-5',
  SMART_PRICE_KEY: 'claude-sonnet-5-global',
  SMART_MAX_TOKENS: '2048',
  SMART_MIN_CACHE_TOKENS: '1024',
  SMART_THINKING: 'low',
};
