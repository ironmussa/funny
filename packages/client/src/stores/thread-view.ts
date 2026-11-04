import type { Thread } from '@funny/shared';

import { readThreadRow } from '@/data/threads/read';

import type { ThreadWithMessages } from './thread-types';

/**
 * The thread the detail view shows: the loaded conversation payload
 * (`threadDataById` / `activeThread`: messages, events, waiting state, …)
 * with the row fields (status, title, stage, …) of the thread's row in the
 * data layer's threads collection — the only place row fields are kept up
 * to date. The payload's own copies of row fields are a snapshot from load
 * time and are never read; the row always wins.
 *
 * Read the detail thread through this module (or the `stores/thread-context`
 * hooks built on it), never through the payload directly.
 */

const merged = new WeakMap<object, WeakMap<Thread, object>>();

/**
 * `payload` with `row`'s fields on top. Memoized per (payload, row) pair, so
 * an unchanged pair returns the same object — safe inside store selectors.
 */
export function mergeThreadView<T extends { id: string }>(
  payload: T | null | undefined,
  row: Thread | undefined,
): T | null {
  if (!payload) return null;
  if (!row || row.id !== payload.id) return payload;
  let byRow = merged.get(payload);
  if (!byRow) {
    byRow = new WeakMap();
    merged.set(payload, byRow);
  }
  let view = byRow.get(row) as T | undefined;
  if (!view) {
    view = { ...payload, ...row };
    byRow.set(row, view);
  }
  return view;
}

/** Imperative read of a thread's detail view from a store state. */
export function readThreadView(
  state: { threadDataById: Record<string, ThreadWithMessages> },
  threadId: string | null | undefined,
): ThreadWithMessages | null {
  if (!threadId) return null;
  return mergeThreadView(state.threadDataById[threadId], readThreadRow(threadId));
}

/** Imperative read of the open thread (`activeThread`) with current row fields. */
export function readActiveThreadView(state: {
  activeThread: ThreadWithMessages | null;
}): ThreadWithMessages | null {
  return mergeThreadView(state.activeThread, readThreadRow(state.activeThread?.id));
}
