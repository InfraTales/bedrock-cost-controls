import { isPriceKey, PRICES, type ModelPrice } from './pricing';

export type Tier = 'fast' | 'smart';

export interface ModelConfig {
  /** Model ID, inference profile ID or application inference profile ARN. */
  modelId: string;
  price: ModelPrice;
  /** Hard ceiling on output tokens per call. It also caps what one call can cost. */
  maxTokens: number;
  /** Smallest prompt prefix the model will cache. Below it, a cache point does nothing. */
  minCacheTokens: number;
  /**
   * Claude Haiku 5.5 and Sonnet 5.5 think by default, and thinking bills as output
   * tokens. "off" turns it off; "low" keeps adaptive thinking at low effort.
   * Either way, maxTokens caps thinking plus answer together.
   */
  thinking: Thinking;
}

export type Thinking = 'off' | 'low';

export interface GatewayConfig {
  tableName: string;
  dailyBudgetMicroUsd: number;
  models: Record<Tier, ModelConfig>;
}

/** Longest prompt we accept. It bounds the input side of every reservation. */
export const MAX_PROMPT_CHARS = 8_000;

export function requireEnv(name: string, env: NodeJS.ProcessEnv = process.env): string {
  const value = env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

function positiveInt(name: string, env: NodeJS.ProcessEnv): number {
  const raw = requireEnv(name, env);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got "${raw}"`);
  }
  return value;
}

function thinking(name: string, env: NodeJS.ProcessEnv): Thinking {
  const raw = requireEnv(name, env);
  if (raw !== 'off' && raw !== 'low') throw new Error(`${name} must be "off" or "low", got "${raw}"`);
  return raw;
}

function model(prefix: string, env: NodeJS.ProcessEnv): ModelConfig {
  const priceKey = requireEnv(`${prefix}_PRICE_KEY`, env);
  if (!isPriceKey(priceKey)) {
    throw new Error(`${prefix}_PRICE_KEY "${priceKey}" has no entry in PRICES`);
  }
  return {
    modelId: requireEnv(`${prefix}_MODEL_ID`, env),
    price: PRICES[priceKey],
    maxTokens: positiveInt(`${prefix}_MAX_TOKENS`, env),
    minCacheTokens: positiveInt(`${prefix}_MIN_CACHE_TOKENS`, env),
    thinking: thinking(`${prefix}_THINKING`, env),
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  return {
    tableName: requireEnv('TABLE_NAME', env),
    dailyBudgetMicroUsd: positiveInt('DAILY_BUDGET_MICRO_USD', env),
    models: { fast: model('FAST', env), smart: model('SMART', env) },
  };
}
