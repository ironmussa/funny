import { useMachine } from '@xstate/react';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { fromPromise } from 'xstate';

import { useGitStatusForThread, useProjectGitStatus } from '@/data/git-status/hooks';
import { useStableCallback } from '@/hooks/use-stable-callback';
import { gitHistoryFingerprint } from '@/lib/git-history-fingerprint';
import { subscribeGitHistoryChanged } from '@/lib/git-history-invalidation';
import { metric } from '@/lib/telemetry';
import { historyRefreshMachine } from '@/machines/history-refresh-machine';

interface GitHistoryAutoRefreshOptions<Loaded> {
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
  refresh: () => Promise<Loaded>;
}

/** Bind the machine's reload to the caller's loader, timing each auto-refresh. */
function withRefreshLoader<Loaded>(refresh: () => Promise<Loaded>) {
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
 * debounces them and reloads only when the tab is visible and idle. Changes the
 * fingerprint cannot see (a branch's PR found after the graph was served) come
 * through {@link subscribeGitHistoryChanged}.
 *
 * Returns `invalidate`, for callers that know history changed (e.g. after a
 * push or pull). Going through the machine instead of reloading directly lets
 * it merge with the reload the resulting status change triggers on its own.
 */
export function useGitHistoryAutoRefresh<Loaded>({
  effectiveThreadId,
  projectModeId,
  contextKey: rawContextKey,
  visible: rawVisible,
  enabled,
  busy,
  refresh,
}: GitHistoryAutoRefreshOptions<Loaded>): () => void {
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

  const invalidate = useCallback(() => send({ type: 'INVALIDATED' }), [send]);
  useHistoryChangedSignal(effectiveThreadId, projectModeId, invalidate);
  return invalidate;
}

/**
 * Call `invalidate` when the runtime reports a change to this history. Thread-mode
 * history is keyed by thread id, project-mode by project id.
 */
function useHistoryChangedSignal(
  threadId: string | undefined,
  projectId: string | null,
  invalidate: () => void,
) {
  const historyKey = threadId ?? projectId;
  useEffect(() => {
    if (!historyKey) return;
    return subscribeGitHistoryChanged((key) => {
      if (key === historyKey) invalidate();
    });
  }, [historyKey, invalidate]);
}
