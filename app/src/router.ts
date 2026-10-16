import type { Tier } from './config';

/** Tasks that need the capable model. Everything else goes to the cheap one. */
const SMART_TASKS = new Set(['code', 'analysis', 'planning']);

export const TASKS = ['chat', 'classify', 'extract', 'summarize', 'code', 'analysis', 'planning'] as const;
export type Task = (typeof TASKS)[number];

/**
 * Picks the model tier for a request. The caller may ask for a tier; otherwise
 * the task decides. Cheap by default: a request has to earn the expensive model.
 */
export function chooseTier(task: Task, requested?: Tier): Tier {
  if (requested) return requested;
  return SMART_TASKS.has(task) ? 'smart' : 'fast';
}
