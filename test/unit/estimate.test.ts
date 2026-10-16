import { reservationMicroUsd, shouldCache, tokensHigh, tokensRough } from '../../app/src/estimate';
import { costMicroUsd } from '../../app/src/pricing';
import { SYSTEM_PROMPT } from '../../app/src/system-prompt';
import { fastModel, smartModel } from '../support/env';

test('tokensHigh counts UTF-8 bytes, so non-English text is not underestimated', () => {
  expect(tokensHigh('abc')).toBe(3);
  expect(tokensHigh('é')).toBe(2);
  expect(tokensHigh('日本')).toBe(6);
});

test('the shipped system prompt is long enough to cache on both models', () => {
  expect(tokensRough(SYSTEM_PROMPT)).toBeGreaterThanOrEqual(smartModel.minCacheTokens);
  expect(shouldCache(fastModel, SYSTEM_PROMPT)).toBe(true);
  expect(shouldCache(smartModel, SYSTEM_PROMPT)).toBe(true);
});

test('a short system prompt gets no cache point', () => {
  const short = 'x'.repeat(4 * 600); // about 600 tokens: enough for Haiku 5.5, not for Sonnet 5
  expect(shouldCache(fastModel, short)).toBe(true);
  expect(shouldCache(smartModel, short)).toBe(false);
});

test('the reservation covers a call that uses every output token it is allowed', () => {
  const prompt = 'Explain how runbook runs are recorded.';
  for (const model of [fastModel, smartModel]) {
    const reserve = reservationMicroUsd(model, SYSTEM_PROMPT, prompt, true);
    const systemTokens = tokensRough(SYSTEM_PROMPT);
    // Worst realistic case: the whole system prompt written to cache, all output used.
    const worst = costMicroUsd(model.price, {
      inputTokens: tokensRough(prompt),
      outputTokens: model.maxTokens,
      cacheReadInputTokens: 0,
      cacheWriteInputTokens: systemTokens,
    });
    expect(reserve).toBeGreaterThanOrEqual(worst);
  }
});

test('the system prompt is priced as a cache write only when it is cached', () => {
  const cached = reservationMicroUsd(smartModel, SYSTEM_PROMPT, 'hi', true);
  const plain = reservationMicroUsd(smartModel, SYSTEM_PROMPT, 'hi', false);
  expect(cached).toBeGreaterThan(plain);
});

test('output dominates the reservation for the smart model', () => {
  const reserve = reservationMicroUsd(smartModel, SYSTEM_PROMPT, 'hi', true);
  expect(smartModel.maxTokens * smartModel.price.output).toBeGreaterThan(reserve / 2);
});
