/**
 * Prices in US dollars per million tokens, called from us-east-1. Source: the AWS Price List API offer file
 * AmazonBedrockFoundationModels, us-east-1, version 20261012084008, checked 2026-10-16.
 * See docs/cost.md for the usage types behind each number.
 *
 * A neat property: dollars per million tokens is the same number as micro-dollars
 * per token. The budget counts micro-dollars (1 USD = 1,000,000).
 */
export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  /** Cache write with the default 5-minute TTL. */
  cacheWrite: number;
}

export const PRICES = {
  // Global cross-Region inference profiles (global.*): about 10% cheaper than geo.
  // Claude Haiku 5.5 bills prompts over 100,000 tokens at long-context rates; the
  // gateway caps prompts far below that (see MAX_PROMPT_CHARS).
  'claude-haiku-5-5-global': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  // Sonnet 5.5 cache reads cost a twentieth of input: the Bedrock pricing page says they
  // were cut by 50% on 7 October 2026.
  'claude-sonnet-5-5-global': { input: 2.0, output: 10.0, cacheRead: 0.1, cacheWrite: 2.5 },
  // Geographic profiles (us.*), which application inference profiles copy from here.
  'claude-haiku-5-5-geo': { input: 0.11, output: 0.55, cacheRead: 0.011, cacheWrite: 0.1375 },
  'claude-sonnet-5-5-geo': { input: 2.2, output: 11.0, cacheRead: 0.11, cacheWrite: 2.75 },
} as const satisfies Record<string, ModelPrice>;

export type PriceKey = keyof typeof PRICES;

export function isPriceKey(value: string): value is PriceKey {
  return Object.hasOwn(PRICES, value);
}

export interface Usage {
  /** Input tokens that were neither read from nor written to the cache. */
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheWriteInputTokens: number;
}

/** Cost of one call in micro-dollars, rounded up so the budget never undercounts. */
export function costMicroUsd(price: ModelPrice, usage: Usage): number {
  const raw =
    usage.inputTokens * price.input +
    usage.outputTokens * price.output +
    usage.cacheReadInputTokens * price.cacheRead +
    usage.cacheWriteInputTokens * price.cacheWrite;
  // Round to 6 places first so float noise (0.1 + 0.2) can't push an exact value up by 1.
  return Math.ceil(Number(raw.toFixed(6)));
}
