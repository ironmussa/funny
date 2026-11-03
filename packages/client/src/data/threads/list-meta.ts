import { createStore, type StoreApi } from 'zustand/vanilla';

/**
 * List metadata for thread sources. This is not entity data: rows live
 * only in the threads collection.
 *
 * A *source* is one server list:
 *   - `project:<id>` for a project's list
 *   - `scratch`
 *   - `shared` (threads shared with me)
 *
 * `members` keeps each source's IDs in server order. The shared list is
 * ordered by share date, which a thread row does not carry, so order cannot
 * be derived from rows alone. A missing entry means "never loaded", which
 * is different from an empty list (spec: *Event for an unloaded project*).
 */

export type ThreadSourceKey = `project:${string}` | 'scratch' | 'shared';

export function projectSource(projectId: string): ThreadSourceKey {
  return `project:${projectId}`;
}

export interface ThreadListMetaState {
  members: Partial<Record<ThreadSourceKey, string[]>>;
  totals: Partial<Record<ThreadSourceKey, number>>;
}

export type ThreadListMetaStore = StoreApi<ThreadListMetaState>;

export function createThreadListMeta(): ThreadListMetaStore {
  return createStore<ThreadListMetaState>(() => ({ members: {}, totals: {} }));
}

function sameIds(a: readonly string[] | undefined, b: readonly string[]): boolean {
  if (!a || a.length !== b.length) return false;
  return a.every((id, i) => id === b[i]);
}

/** Set a source's members and total, keeping references when unchanged. */
export function setSourceMembers(
  meta: ThreadListMetaStore,
  source: ThreadSourceKey,
  ids: string[],
  total: number,
): void {
  const state = meta.getState();
  const membersSame = sameIds(state.members[source], ids);
  if (membersSame && state.totals[source] === total) return;
  meta.setState({
    members: membersSame ? state.members : { ...state.members, [source]: ids },
    totals: { ...state.totals, [source]: total },
  });
}

/** Remove a thread from every source, decrementing totals. */
export function removeFromSources(meta: ThreadListMetaStore, threadId: string): void {
  const { members, totals } = meta.getState();
  const memberPatch: Partial<Record<ThreadSourceKey, string[]>> = {};
  const totalPatch: Partial<Record<ThreadSourceKey, number>> = {};
  for (const source of Object.keys(members) as ThreadSourceKey[]) {
    const ids = members[source]!;
    if (!ids.includes(threadId)) continue;
    memberPatch[source] = ids.filter((id) => id !== threadId);
    totalPatch[source] = Math.max(0, (totals[source] ?? ids.length) - 1);
  }
  if (Object.keys(memberPatch).length === 0) return;
  meta.setState({ members: { ...members, ...memberPatch }, totals: { ...totals, ...totalPatch } });
}

/** Forget a source entirely (back to "never loaded"). */
export function clearSource(meta: ThreadListMetaStore, source: ThreadSourceKey): void {
  const { members, totals } = meta.getState();
  if (!(source in members) && !(source in totals)) return;
  const { [source]: _m, ...restMembers } = members;
  const { [source]: _t, ...restTotals } = totals;
  meta.setState({ members: restMembers, totals: restTotals });
}
