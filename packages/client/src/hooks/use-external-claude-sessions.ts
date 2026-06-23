import { useEffect, useSyncExternalStore } from 'react';

import { api } from '@/lib/api';
import type { ExternalClaudeSession } from '@/lib/api/system';

interface ExternalClaudeSessionsSnapshot {
  sessions: ExternalClaudeSession[];
  hasLoaded: boolean;
  isRefreshing: boolean;
}

const REFRESH_INTERVAL_MS = 15_000;
const ALL_PROJECTS_KEY = '__all__';
const EMPTY_SNAPSHOT: ExternalClaudeSessionsSnapshot = {
  sessions: [],
  hasLoaded: false,
  isRefreshing: false,
};
const listeners = new Set<() => void>();
const snapshots = new Map<string, ExternalClaudeSessionsSnapshot>();
const inflightByKey = new Map<string, Promise<void>>();

function emit() {
  for (const listener of listeners) listener();
}

function snapshotKey(projectId?: string | null) {
  return projectId ?? ALL_PROJECTS_KEY;
}

function setSnapshot(key: string, next: ExternalClaudeSessionsSnapshot) {
  snapshots.set(key, next);
  emit();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(key: string) {
  return snapshots.get(key) ?? EMPTY_SNAPSHOT;
}

// A single request with no `projectId` makes the runner scan *every* project
// the user owns and sync all importable Claude Code sessions into thread shells
// in one pass (the synced threads then arrive via the `thread:created` WS
// event). So there is no need to poll per project — one global poll covers them
// all. The `projectId` arg is retained only so callers can scope a refresh.
export function loadExternalClaudeSessions(
  opts: { force?: boolean; projectId?: string | null } = {},
) {
  const key = snapshotKey(opts.projectId);
  const snapshot = getSnapshot(key);
  const inflight = inflightByKey.get(key);
  if (inflight) return inflight;
  if (snapshot.hasLoaded && !opts.force) return Promise.resolve();

  setSnapshot(key, { ...snapshot, isRefreshing: true });

  const request = Promise.resolve(api.listExternalClaudeSessions({ projectId: opts.projectId }))
    .then((result) => {
      setSnapshot(key, {
        sessions: result.isErr() ? [] : result.value.sessions,
        hasLoaded: true,
        isRefreshing: false,
      });
    })
    .catch(() => {
      setSnapshot(key, { sessions: [], hasLoaded: true, isRefreshing: false });
    })
    .finally(() => {
      inflightByKey.delete(key);
    });

  inflightByKey.set(key, request);
  return request;
}

/**
 * Owns the single, global polling loop that syncs external Claude Code sessions
 * across all projects. Mount this ONCE (at the sidebar root) — do not call it
 * per project, or you reintroduce the N-requests-per-interval fan-out.
 */
export function useExternalClaudeSessionsSync(): void {
  useEffect(() => {
    void loadExternalClaudeSessions({});
    const interval = window.setInterval(() => {
      void loadExternalClaudeSessions({ force: true });
    }, REFRESH_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, []);
}

/**
 * Read-only subscriber to the global sync's `hasLoaded` flag. Components (e.g.
 * `ProjectItem`) use this to gate their "no threads yet" empty state without
 * triggering their own fetch.
 */
export function useExternalClaudeSessionsLoaded(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => getSnapshot(ALL_PROJECTS_KEY).hasLoaded,
    () => getSnapshot(ALL_PROJECTS_KEY).hasLoaded,
  );
}

export function resetExternalClaudeSessionsForTests() {
  snapshots.clear();
  inflightByKey.clear();
  emit();
}
