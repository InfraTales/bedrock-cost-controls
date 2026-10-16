import { DeleteCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { BudgetStore, dayKey } from '../../app/src/budget';
import { createTable, dropTable, localDynamo } from '../support/ddb';

const { client, doc } = localDynamo();
let table: string;

beforeEach(async () => {
  table = await createTable(client);
});
afterEach(async () => {
  await dropTable(client, table);
});

const at = (iso: string) => () => new Date(iso);

async function item(userId: string, day: string) {
  const out = await doc.send(new GetCommand({ TableName: table, Key: { pk: `USER#${userId}`, sk: `DAY#${day}` } }));
  return out.Item;
}

test('a reservation that fits is recorded against today', async () => {
  const store = new BudgetStore(doc, table, 1000, at('2026-10-16T09:00:00Z'));
  await expect(store.reserve('u1', 400)).resolves.toEqual({ ok: true, day: '2026-10-16', amount: 400 });
  expect(await store.usedToday('u1')).toBe(400);
});

test('a reservation that lands exactly on the limit is allowed; one more micro-dollar is not', async () => {
  const store = new BudgetStore(doc, table, 1000, at('2026-10-16T09:00:00Z'));
  expect((await store.reserve('u1', 600)).ok).toBe(true);
  expect((await store.reserve('u1', 400)).ok).toBe(true);
  expect(await store.usedToday('u1')).toBe(1000);
  await expect(store.reserve('u1', 1)).resolves.toEqual({ ok: false, reason: 'over_budget' });
  expect(await store.usedToday('u1')).toBe(1000);
});

test('a single call bigger than the whole budget is refused without a write', async () => {
  const store = new BudgetStore(doc, table, 1000, at('2026-10-16T09:00:00Z'));
  await expect(store.reserve('u1', 1001)).resolves.toEqual({ ok: false, reason: 'over_budget' });
  expect(await item('u1', '2026-10-16')).toBeUndefined();
});

test('users have separate counters', async () => {
  const store = new BudgetStore(doc, table, 1000, at('2026-10-16T09:00:00Z'));
  expect((await store.reserve('u1', 1000)).ok).toBe(true);
  expect((await store.reserve('u2', 1000)).ok).toBe(true);
});

test('settling replaces the reservation with the real cost and returns the new total', async () => {
  const store = new BudgetStore(doc, table, 1000, at('2026-10-16T09:00:00Z'));
  const r = await store.reserve('u1', 700);
  if (!r.ok) throw new Error('expected a reservation');
  await expect(store.settle('u1', r, 120)).resolves.toBe(120);
  // The 580 given back is spendable again.
  expect((await store.reserve('u1', 880)).ok).toBe(true);
});

test('release gives the whole reservation back', async () => {
  const store = new BudgetStore(doc, table, 1000, at('2026-10-16T09:00:00Z'));
  const r = await store.reserve('u1', 700);
  if (!r.ok) throw new Error('expected a reservation');
  await store.release('u1', r);
  expect(await store.usedToday('u1')).toBe(0);
});

test('the budget resets at 00:00 UTC', async () => {
  let now = new Date('2026-10-16T23:59:00Z');
  const store = new BudgetStore(doc, table, 1000, () => now);
  expect((await store.reserve('u1', 1000)).ok).toBe(true);
  expect((await store.reserve('u1', 1)).ok).toBe(false);
  now = new Date('2026-10-17T00:00:01Z');
  expect((await store.reserve('u1', 1000)).ok).toBe(true);
});

test('a call that crosses midnight settles against the day it was reserved on', async () => {
  let now = new Date('2026-10-16T23:59:59Z');
  const store = new BudgetStore(doc, table, 1000, () => now);
  const r = await store.reserve('u1', 900);
  if (!r.ok) throw new Error('expected a reservation');
  now = new Date('2026-10-17T00:00:02Z');
  await store.settle('u1', r, 100);
  expect((await item('u1', '2026-10-16'))?.used).toBe(100);
  // The new day starts clean: no negative balance carried in from yesterday's refund.
  expect(await item('u1', '2026-10-17')).toBeUndefined();
  expect(await store.usedToday('u1')).toBe(0);
});

test('each counter gets a TTL a week after its day ends, and keeps it on later writes', async () => {
  const store = new BudgetStore(doc, table, 1000, at('2026-10-16T09:00:00Z'));
  await store.reserve('u1', 10);
  const first = (await item('u1', '2026-10-16'))?.expiresAt;
  expect(first).toBe(Date.parse('2026-10-17T00:00:00Z') / 1000 + 7 * 24 * 3600);
  await store.reserve('u1', 10);
  expect((await item('u1', '2026-10-16'))?.expiresAt).toBe(first);
});

test('a settle after someone deleted the counter still leaves a TTL on the item', async () => {
  const store = new BudgetStore(doc, table, 1000, at('2026-10-16T09:00:00Z'));
  const r = await store.reserve('u1', 500);
  if (!r.ok) throw new Error('expected a reservation');
  await doc.send(new DeleteCommand({ TableName: table, Key: { pk: 'USER#u1', sk: 'DAY#2026-10-16' } }));
  await store.settle('u1', r, 100);
  expect(await item('u1', '2026-10-16')).toEqual(expect.objectContaining({ used: -400, expiresAt: expect.any(Number) }));
});

test('concurrent reservations never overspend: exactly as many succeed as fit', async () => {
  const store = new BudgetStore(doc, table, 1000, at('2026-10-16T09:00:00Z'));
  // 60 requests of 30 each race for a 1,000 budget. 33 fit (990); 27 must be refused.
  const results = await Promise.all(Array.from({ length: 60 }, () => store.reserve('u1', 30)));
  expect(results.filter((r) => r.ok)).toHaveLength(33);
  expect(await store.usedToday('u1')).toBe(990);
});

test('concurrent reservations of different sizes stay under the limit', async () => {
  const store = new BudgetStore(doc, table, 10_000, at('2026-10-16T09:00:00Z'));
  const sizes = Array.from({ length: 80 }, (_, i) => 50 + ((i * 37) % 400));
  const results = await Promise.all(sizes.map((s) => store.reserve('u1', s)));
  const granted = sizes.filter((_, i) => results[i]?.ok).reduce((a, b) => a + b, 0);
  const used = await store.usedToday('u1');
  expect(used).toBe(granted);
  expect(used).toBeLessThanOrEqual(10_000);
  // Every refused request really didn't fit at the end (no false refusals left room).
  const smallestRefused = Math.min(...sizes.filter((_, i) => !results[i]?.ok));
  expect(used + smallestRefused).toBeGreaterThan(10_000);
});

test('dayKey uses the UTC date', () => {
  expect(dayKey(new Date('2026-10-16T23:30:00-05:00'))).toBe('2026-10-17');
});

test('rejects nonsense reservation amounts', async () => {
  const store = new BudgetStore(doc, table, 1000);
  await expect(store.reserve('u1', 0)).rejects.toThrow('positive integer');
  await expect(store.reserve('u1', 1.5)).rejects.toThrow('positive integer');
});
