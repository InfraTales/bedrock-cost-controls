import { BASE, monthlyUsd, table } from '../../scripts/cost-model';

test('all-Sonnet without caching matches a hand calculation', () => {
  // Per call: 1,500 input x $2/M + 800 output x $10/M = $0.011. Times 600,000 calls.
  expect(monthlyUsd({ ...BASE, smartShare: 1, cacheHitRate: 0 })).toBe(6600);
});

test('routing saves more than caching for this traffic', () => {
  const allSmart = monthlyUsd({ ...BASE, smartShare: 1, cacheHitRate: 0 });
  const routed = monthlyUsd({ ...BASE, cacheHitRate: 0 });
  const cached = monthlyUsd(BASE);
  expect(allSmart - routed).toBeGreaterThan(routed - cached);
  expect(cached).toBeLessThan(routed);
});

test('geo profiles cost 10% more than global', () => {
  expect(monthlyUsd({ ...BASE, cacheHitRate: 0 }, 'geo')).toBeCloseTo(monthlyUsd({ ...BASE, cacheHitRate: 0 }) * 1.1, 0);
});

test('the printed table has the numbers the docs quote', () => {
  expect(table()).toEqual([
    ['Everything on Sonnet 5, no caching, geo profile', 7260],
    ['Everything on Sonnet 5, no caching', 6600],
    ['Routed 80/20, no caching', 1464],
    ['Routed 80/20, with caching (the repo)', 1148.58],
    ['Routed 80/20, with caching, geo profile', 1263.75],
  ]);
});
