import { useMachine } from '@xstate/react';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { fromPromise } from 'xstate';

import { useGitStatusForThread, useProjectGitStatus } from '@/data/git-status/hooks';
import { useStableCallback } from '@/hooks/use-stable-callback';
import { gitHistoryFingerprint } from '@/lib/git-history-fingerprint';
import { metric } from '@/lib/telemetry';
import { historyRefreshMachine } from '@/machines/history-refresh-machine';

interface GitHistoryAutoRefreshOptions {
  effectiveThreadId: string | undefined;
  projectModeId: string | null;
  /** Identity of the loaded history; a change means the caller reloads it itself. */
  contextKey: string | null | undefined;
  visible: boolean | undefined;
  /** The target can show git history at all. */
  enabled: boolean;
  /** A history load is already in flight. */
  busy: boolean;
  /** Reload the first page of history (called with no arguments). */
  refresh: () => Promise<unknown>;
}

/** Bind the machine's reload to the caller's loader, timing each auto-refresh. */
function withRefreshLoader(refresh: () => Promise<unknown>) {
  return historyRefreshMachine.provide({
    actors: {
      refreshHistory: fromPromise(async () => {
        const started = performance.now();
        await refresh();
        metric('git.history.auto_refresh', performance.now() - started);
      }),
    },
  });
}

/**
 * Keep a loaded commit history in sync with the repository.
 *
 * Observes the git-status store — the single place every history-changing
 * signal converges (WS `git:status`, `git:refs-updated`, status refetches after
 * commit / push / pull, window focus) — and feeds changes in the
 * history-relevant fingerprint into {@link historyRefreshMachine}, which
 * debounces them and reloads only when the tab is visible and idle.
 *
 * Returns `invalidate`, for callers that know history changed (e.g. after a
 * push or pull). Going through the machine instead of reloading directly lets
 * it merge with the reload the resulting status change triggers on its own.
 */
export function useGitHistoryAutoRefresh({
  effectiveThreadId,
  projectModeId,
  contextKey: rawContextKey,
  visible: rawVisible,
  enabled,
  busy,
  refresh,
}: GitHistoryAutoRefreshOptions): () => void {
  const contextKey = rawContextKey ?? '';
  const visible = !!rawVisible && enabled;
  const threadStatus = useGitStatusForThread(effectiveThreadId);
  const projectStatus = useProjectGitStatus(effectiveThreadId ? null : projectModeId);
  const fingerprint = gitHistoryFingerprint(effectiveThreadId ? threadStatus : projectStatus);

  const stableRefresh = useStableCallback(refresh);
  const machine = useMemo(() => withRefreshLoader(stableRefresh), [stableRefresh]);
  const [, send] = useMachine(machine, { input: { visible } });

  useEffect(() => {
    send({ type: 'VISIBILITY', visible });
  }, [visible, send]);

  useEffect(() => {
    send({ type: 'BUSY', busy });
  }, [busy, send]);

  // Only a change WITHIN one context is a history change; switching context
  // (or the first status for it arriving) just records the new baseline.
  const baselineRef = useRef<{ contextKey: string; fingerprint: string | null } | null>(null);
  useEffect(() => {
    const baseline = baselineRef.current;
    baselineRef.current = { contextKey, fingerprint };
    if (!baseline || baseline.contextKey !== contextKey) {
      send({ type: 'RESET' });
      return;
    }
    if (baseline.fingerprint !== null && fingerprint !== null) {
      if (baseline.fingerprint !== fingerprint) send({ type: 'INVALIDATED' });
    } else if (fingerprint === null) {
      // Status dropped (e.g. evicted); keep the last known baseline.
      baselineRef.current = baseline;
    }
  }, [contextKey, fingerprint, send]);

  return useCallback(() => send({ type: 'INVALIDATED' }), [send]);
}
