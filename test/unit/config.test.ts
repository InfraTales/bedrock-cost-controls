import { loadConfig, requireEnv } from '../../app/src/config';
import { PRICES } from '../../app/src/pricing';
import { lambdaEnv } from '../support/env';

test('loads the environment the stack sets', () => {
  const config = loadConfig(lambdaEnv);
  expect(config.dailyBudgetMicroUsd).toBe(500_000);
  expect(config.models.fast).toEqual({
    modelId: 'global.anthropic.claude-haiku-5-5',
    price: PRICES['claude-haiku-5-5-global'],
    maxTokens: 1024,
    minCacheTokens: 512,
    thinking: 'off',
  });
  expect(config.models.smart.thinking).toBe('low');
});

test('missing or blank variables fail at start-up, not mid-request', () => {
  expect(() => requireEnv('NOPE', {})).toThrow('Missing required environment variable NOPE');
  expect(() => loadConfig({ ...lambdaEnv, TABLE_NAME: ' ' })).toThrow('TABLE_NAME');
});

test('bad numbers, unknown prices and unknown thinking modes are rejected', () => {
  expect(() => loadConfig({ ...lambdaEnv, DAILY_BUDGET_MICRO_USD: '0.5' })).toThrow('positive integer');
  expect(() => loadConfig({ ...lambdaEnv, FAST_MAX_TOKENS: '-1' })).toThrow('positive integer');
  expect(() => loadConfig({ ...lambdaEnv, SMART_PRICE_KEY: 'claude-opus' })).toThrow('no entry in PRICES');
  expect(() => loadConfig({ ...lambdaEnv, FAST_THINKING: 'high' })).toThrow('"off" or "low"');
});
