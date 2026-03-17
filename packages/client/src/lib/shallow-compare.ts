import type { Thread } from '@funny/shared';

/**
 * Thread fields that affect sidebar/list rendering.
 *
 * When comparing thread objects to decide whether to re-render, only these
 * fields matter. Fields like `cost`, `sessionId`, `stage`, `initTools`,
 * `contextUsage`, etc. change frequently via WebSocket but don't affect the
 * sidebar display.
 */
const THREAD_VISUAL_KEYS: readonly (keyof Thread)[] = [
  'id',
  'title',
  'status',
  'pinned',
  'mode',
  'branch',
  'worktreePath',
  'createdBy',
  'createdAt',
  'completedAt',
  'archived',
  'provider',
  'lastAssistantMessage',
  'arcId',
  'purpose',
] as const;

/**
 * Returns `true` when two Thread objects are visually identical for sidebar
 * rendering purposes. Ignores high-churn fields (cost, sessionId, etc.).
 */
export function threadsVisuallyEqual(a: Thread, b: Thread): boolean {
  if (a === b) return true;
  for (const key of THREAD_VISUAL_KEYS) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}

/**
 * Shallow array comparison with a custom element comparator.
 *
 * Returns `true` when both arrays have the same length and every pair of
 * elements at the same index satisfies `eq(a[i], b[i])`.
 */
export function arraysEqual<T>(
  a: readonly T[],
  b: readonly T[],
  eq: (x: T, y: T) => boolean = Object.is,
): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (!eq(a[i], b[i])) return false;
  }
  return true;
}
