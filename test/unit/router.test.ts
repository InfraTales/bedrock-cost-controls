import { chooseTier } from '../../app/src/router';

test('cheap tasks go to the fast model', () => {
  for (const task of ['chat', 'classify', 'extract', 'summarize'] as const) expect(chooseTier(task)).toBe('fast');
});

test('hard tasks go to the smart model', () => {
  for (const task of ['code', 'analysis', 'planning'] as const) expect(chooseTier(task)).toBe('smart');
});

test('an explicit tier wins over the task', () => {
  expect(chooseTier('chat', 'smart')).toBe('smart');
  expect(chooseTier('code', 'fast')).toBe('fast');
});
