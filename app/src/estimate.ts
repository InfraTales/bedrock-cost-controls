import type { ModelConfig } from './config';

/**
 * A deliberate overestimate of the tokens in a string: one token per UTF-8 byte.
 * Real tokenizers pack several bytes into most tokens, so the reservation is too
 * high, and the settle step gives the difference back once Bedrock reports the
 * real count. Too high is the safe direction for a budget.
 */
export function tokensHigh(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/**
 * A rough count for English text: about 4 characters per token. Used only to
 * decide whether a prompt prefix is long enough to be worth a cache point.
 */
export function tokensRough(text: string): number {
  return Math.floor(text.length / 4);
}

/** Should the system prompt get a cache point for this model? */
export function shouldCache(model: ModelConfig, systemPrompt: string): boolean {
  return tokensRough(systemPrompt) >= model.minCacheTokens;
}

/**
 * The most one call can cost, in micro-dollars. Output is capped exactly by
 * maxTokens. Input uses the overestimate, priced as a cache write when the
 * system prompt is cached, because a cache write costs more than plain input.
 */
export function reservationMicroUsd(
  model: ModelConfig,
  systemPrompt: string,
  prompt: string,
  cacheSystem: boolean,
): number {
  const { price } = model;
  const systemRate = cacheSystem ? Math.max(price.cacheWrite, price.input) : price.input;
  const raw =
    tokensHigh(systemPrompt) * systemRate + tokensHigh(prompt) * price.input + model.maxTokens * price.output;
  return Math.ceil(Number(raw.toFixed(6)));
}
