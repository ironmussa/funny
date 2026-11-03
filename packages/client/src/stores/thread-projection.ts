import type { Thread } from '@funny/shared';
import type { StoreApi } from 'zustand';

import type { DataLayer } from '@/data/data-layer';
import { getDataLayer, subscribeDataLayer } from '@/data/runtime';
import { getThreadsData } from '@/data/threads/store';

import type { ThreadState } from './thread-state';

/**
 * MIGRATION SHIM (adopt-tanstack-db-client, design D8). Removed in phase 5.
 *
 * Thread rows live only in the data layer's threads collection. The right
 * pane still reads row fields (status, title, stage, …) from its loaded
 * payload copy, `activeThread`. This mirror keeps that copy in step: when a
 * row changes — optimistic write, rollback, confirmation, realtime event —
 * the fields that changed are copied onto `activeThread`, as
 * `mutations.patchThread` did before the migration. Only changed fields are
 * copied, because the loaded payload can be fresher than the list row. The
 * activeThread → threadDataById subscriber in thread-store copies it into the
 * payload map.
 */

function changedFields(prev: Thread | undefined, next: Thread): Partial<Thread> | null {
  if (!prev || prev === next) return null;
  const changed: Partial<Record<keyof Thread, unknown>> = {};
  let any = false;
  for (const key of Object.keys(next) as (keyof Thread)[]) {
    if (!Object.is(prev[key], next[key])) {
      changed[key] = next[key];
      any = true;
    }
  }
  return any ? (changed as Partial<Thread>) : null;
}

export function installActiveThreadMirror(store: StoreApi<ThreadState>): () => void {
  let detach: () => void = () => {};

  function attach(layer: DataLayer): void {
    detach();
    const data = getThreadsData(layer);
    const lastRows = new Map<string, Thread>();
    const subscription = data.collection.subscribeChanges(
      (changes) => {
        const state = store.getState();
        const activeId = state.activeThread?.id;
        const activeChanges: Partial<Thread> = {};
        for (const change of changes) {
          const key = String(change.key);
          const row = change.type === 'delete' ? undefined : data.readThread(key);
          const prevRow = lastRows.get(key);
          if (row) lastRows.set(key, row);
          else lastRows.delete(key);
          if (row && activeId === key) Object.assign(activeChanges, changedFields(prevRow, row));
        }
        if (state.activeThread && Object.keys(activeChanges).length > 0) {
          store.setState({ activeThread: { ...state.activeThread, ...activeChanges } });
        }
      },
      // Without the initial state a subscriber only hears deletes of rows it
      // has already seen; start from every current row so none is missed.
      { includeInitialState: true },
    );
    detach = () => subscription.unsubscribe();
  }

  attach(getDataLayer());
  const unsubscribeLayer = subscribeDataLayer(() => attach(getDataLayer()));
  return () => {
    detach();
    unsubscribeLayer();
  };
}
