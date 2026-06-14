import { create } from 'zustand';

/**
 * Live presence for thread-sharing: who is currently viewing each thread.
 * Fed by `presence:sync` / `presence:join` / `presence:leave` WS events
 * (see hooks/ws-event-dispatch.ts) and read by the ThreadView header avatar
 * stack. Awareness-shaped: each viewer is keyed by a per-connection `clientId`.
 */

export interface PresenceViewer {
  clientId: string;
  user: { id: string; name: string; image: string | null };
}

interface PresenceState {
  /** threadId → current viewers (including self). */
  viewersByThread: Record<string, PresenceViewer[]>;
  /** Replace the full roster for a thread (on presence:sync). */
  setRoster: (threadId: string, viewers: PresenceViewer[]) => void;
  /** Add/replace a viewer (on presence:join). */
  upsertViewer: (threadId: string, viewer: PresenceViewer) => void;
  /** Remove a viewer by clientId (on presence:leave). */
  removeViewer: (threadId: string, clientId: string) => void;
  /** Drop a thread's roster entirely (on close / leave). */
  clearThread: (threadId: string) => void;
}

export const usePresenceStore = create<PresenceState>((set) => ({
  viewersByThread: {},

  setRoster: (threadId, viewers) =>
    set((s) => ({ viewersByThread: { ...s.viewersByThread, [threadId]: viewers } })),

  upsertViewer: (threadId, viewer) =>
    set((s) => {
      const current = s.viewersByThread[threadId] ?? [];
      const next = current.filter((v) => v.clientId !== viewer.clientId);
      next.push(viewer);
      return { viewersByThread: { ...s.viewersByThread, [threadId]: next } };
    }),

  removeViewer: (threadId, clientId) =>
    set((s) => {
      const current = s.viewersByThread[threadId];
      if (!current) return s;
      return {
        viewersByThread: {
          ...s.viewersByThread,
          [threadId]: current.filter((v) => v.clientId !== clientId),
        },
      };
    }),

  clearThread: (threadId) =>
    set((s) => {
      if (!(threadId in s.viewersByThread)) return s;
      const next = { ...s.viewersByThread };
      delete next[threadId];
      return { viewersByThread: next };
    }),
}));

/**
 * Distinct viewers for a thread, collapsed by user id (a user with multiple
 * tabs counts once) and excluding `selfUserId`. For the header avatar stack.
 */
export function selectOtherViewers(
  state: PresenceState,
  threadId: string,
  selfUserId: string | null | undefined,
): PresenceViewer['user'][] {
  const viewers = state.viewersByThread[threadId] ?? [];
  const byUser = new Map<string, PresenceViewer['user']>();
  for (const v of viewers) {
    if (v.user.id === selfUserId) continue;
    if (!byUser.has(v.user.id)) byUser.set(v.user.id, v.user);
  }
  return Array.from(byUser.values());
}
