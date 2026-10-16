import { costMicroUsd, isPriceKey, PRICES } from '../../app/src/pricing';

const haiku = PRICES['claude-haiku-5-5-global'];
const sonnet = PRICES['claude-sonnet-5-global'];
const none = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheWriteInputTokens: 0 };

test('one million output tokens cost the list price in micro-dollars', () => {
  expect(costMicroUsd(sonnet, { ...none, outputTokens: 1_000_000 })).toBe(10_000_000); // $10
  expect(costMicroUsd(haiku, { ...none, inputTokens: 1_000_000 })).toBe(100_000); // $0.10
});

test('each kind of token is billed at its own rate', () => {
  const usage = { inputTokens: 1000, outputTokens: 500, cacheReadInputTokens: 2000, cacheWriteInputTokens: 1500 };
  // 1,000 x 2 + 500 x 10 + 2,000 x 0.2 + 1,500 x 2.5
  expect(costMicroUsd(sonnet, usage)).toBe(2000 + 5000 + 400 + 3750);
});

test('a cache read costs a tenth of plain input, a 5-minute cache write a quarter more', () => {
  for (const p of Object.values(PRICES)) {
    expect(p.cacheRead).toBeCloseTo(p.input / 10, 10);
    expect(p.cacheWrite).toBeCloseTo(p.input * 1.25, 10);
  }
});

test('global profiles are cheaper than geo profiles by 10% of the global price', () => {
  expect(PRICES['claude-sonnet-5-geo'].input).toBeCloseTo(sonnet.input * 1.1, 10);
  expect(PRICES['claude-haiku-5-5-geo'].output).toBeCloseTo(haiku.output * 1.1, 10);
});

test('fractions round up, so the budget never undercounts', () => {
  expect(costMicroUsd(haiku, { ...none, inputTokens: 1 })).toBe(1); // 0.1 rounds up to 1
  expect(costMicroUsd(haiku, { ...none, inputTokens: 10 })).toBe(1);
  expect(costMicroUsd(haiku, { ...none, inputTokens: 11 })).toBe(2);
});

test('float noise does not add a micro-dollar to an exact amount', () => {
  // 3 x 0.1 is 0.30000000000000004 in floating point.
  expect(costMicroUsd(haiku, { ...none, inputTokens: 30 })).toBe(3);
});

test('isPriceKey only accepts known models', () => {
  expect(isPriceKey('claude-sonnet-5-global')).toBe(true);
  expect(isPriceKey('toString')).toBe(false);
  expect(isPriceKey('gpt')).toBe(false);
});
