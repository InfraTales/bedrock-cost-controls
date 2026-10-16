/**
 * Monthly cost of the gateway's model calls under stated assumptions, so you can see
 * which lever moves the bill. Prices come from app/src/pricing.ts (AWS Price List API).
 * Run: npm run cost
 */
import { costMicroUsd, PRICES, type ModelPrice } from '../app/src/pricing';

export interface Scenario {
  requestsPerMonth: number;
  /** Share of requests that go to the smart model (0 to 1). */
  smartShare: number;
  systemTokens: number;
  promptTokens: number;
  fastOutputTokens: number;
  smartOutputTokens: number;
  /** Share of calls that read the system prompt from cache; the rest write it. 0 = no caching. */
  cacheHitRate: number;
}

export const BASE: Scenario = {
  requestsPerMonth: 600_000, // 1,000 daily users x 20 requests x 30 days
  smartShare: 0.2,
  systemTokens: 1_300,
  promptTokens: 200,
  fastOutputTokens: 300,
  smartOutputTokens: 800, // includes low-effort thinking, which bills as output
  cacheHitRate: 0.95,
};

function perCall(price: ModelPrice, s: Scenario, outputTokens: number, cached: boolean): number {
  if (!cached) {
    return costMicroUsd(price, { inputTokens: s.systemTokens + s.promptTokens, outputTokens, cacheReadInputTokens: 0, cacheWriteInputTokens: 0 });
  }
  const read = costMicroUsd(price, { inputTokens: s.promptTokens, outputTokens, cacheReadInputTokens: s.systemTokens, cacheWriteInputTokens: 0 });
  const write = costMicroUsd(price, { inputTokens: s.promptTokens, outputTokens, cacheReadInputTokens: 0, cacheWriteInputTokens: s.systemTokens });
  return s.cacheHitRate * read + (1 - s.cacheHitRate) * write;
}

/** Monthly cost in US dollars. */
export function monthlyUsd(s: Scenario, profile: 'global' | 'geo' = 'global'): number {
  const fast = PRICES[`claude-haiku-5-5-${profile}`];
  const smart = PRICES[`claude-sonnet-5-5-${profile}`];
  const cached = s.cacheHitRate > 0;
  const micro =
    s.requestsPerMonth * (1 - s.smartShare) * perCall(fast, s, s.fastOutputTokens, cached) +
    s.requestsPerMonth * s.smartShare * perCall(smart, s, s.smartOutputTokens, cached);
  return Math.round(micro) / 1_000_000;
}

export function table(): [string, number][] {
  return [
    ['Everything on Sonnet 5.5, no caching, geo profile', monthlyUsd({ ...BASE, smartShare: 1, cacheHitRate: 0 }, 'geo')],
    ['Everything on Sonnet 5.5, no caching', monthlyUsd({ ...BASE, smartShare: 1, cacheHitRate: 0 })],
    ['Routed 80/20, no caching', monthlyUsd({ ...BASE, cacheHitRate: 0 })],
    ['Routed 80/20, with caching (the repo)', monthlyUsd(BASE)],
    ['Routed 80/20, with caching, geo profile', monthlyUsd(BASE, 'geo')],
  ];
}

if (require.main === module) {
  for (const [label, usd] of table()) console.log(`${label.padEnd(50)} $${usd.toFixed(2)}`);
}
