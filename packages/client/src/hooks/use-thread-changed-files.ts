import type { FileDiffSummary } from '@funny/shared';
import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '@/lib/api';
import { useReviewPaneStore } from '@/stores/review-pane-store';
import { useThreadId, useThreadStatus } from '@/stores/thread-context';

/** Stable empty Set so that referential equality is preserved across renders. */
const EMPTY_SET = new Set<string>();

/** Tool calls that write to a file path, used to attribute changes to a session. */
const FILE_MUTATING_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

/** Extract the file path a file-mutating tool call targeted, or null. */
function toolCallFilePath(tc: any): string | null {
  if (!tc || !FILE_MUTATING_TOOLS.has(tc.name)) return null;
  let input: any = tc.input;
  if (typeof input === 'string') {
    try {
      input = JSON.parse(input);
    } catch {
      return null;
    }
  }
  const p = input?.file_path ?? input?.notebook_path;
  return typeof p === 'string' && p ? p : null;
}

/**
 * Partition the thread's changed files into per-session buckets, keyed by the
 * user-message id that opened each session (turn). A file lands in every session
 * whose tool calls touched it, so scrolling the thread shows what each session
 * modified. Diff stats come from the current working tree (cumulative), so a file
 * touched across sessions shows the same stats in each — the value is the per-
 * session file list, not a per-session line delta.
 */
export function collectSessionChanges(
  messages: any[],
  changedFiles: FileDiffSummary[],
): Map<string, FileDiffSummary[]> {
  const result = new Map<string, FileDiffSummary[]>();
  if (changedFiles.length === 0) return result;

  // touched paths per user turn
  const touchedByTurn = new Map<string, Set<string>>();
  let currentUserId: string | null = null;
  for (const msg of messages) {
    if (msg.role === 'user') {
      currentUserId = String(msg.id);
      if (!touchedByTurn.has(currentUserId)) touchedByTurn.set(currentUserId, new Set());
    }
    if (!currentUserId) continue;
    const set = touchedByTurn.get(currentUserId)!;
    for (const tc of msg.toolCalls ?? []) {
      const p = toolCallFilePath(tc);
      if (p) set.add(p);
    }
  }

  for (const [uid, touched] of touchedByTurn) {
    if (touched.size === 0) continue;
    // Tool-call paths are absolute; diff summary paths are repo-root-relative.
    const files = changedFiles.filter((f) =>
      [...touched].some((tp) => tp === f.path || tp.endsWith(`/${f.path}`)),
    );
    if (files.length > 0) result.set(uid, files);
  }
  return result;
}

/**
 * Fetch ALL file paths touched by file-modifying tool calls (Write, Edit, NotebookEdit)
 * for the active thread. Uses a dedicated API endpoint that queries the database directly,
 * so it returns complete results regardless of message pagination limits.
 */
function useThreadTouchedPaths(enabled: boolean): Set<string> {
  const threadId = useThreadId();
  const isRunning = useThreadStatus() === 'running';
  const [paths, setPaths] = useState<Set<string>>(EMPTY_SET);
  const prevRef = useRef<Set<string>>(EMPTY_SET);
  const prevThreadIdRef = useRef<string | undefined>(undefined);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    // Clear when switching threads
    if (threadId !== prevThreadIdRef.current) {
      prevThreadIdRef.current = threadId;
      setPaths(EMPTY_SET);
      prevRef.current = EMPTY_SET;
      // Abort any in-flight request for the old thread
      abortRef.current?.abort();
      abortRef.current = null;
    }

    if (!threadId || !enabled) return;

    let cancelled = false;

    const fetchPaths = async () => {
      // Abort the previous in-flight request to prevent pileup when
      // responses are slower than the polling interval
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;

      // Background polling: never let a transient/unexpected failure surface as
      // an unhandled rejection — just skip this tick.
      let result;
      try {
        result = await api.getTouchedFiles(threadId, ac.signal);
      } catch {
        return;
      }
      if (cancelled || ac.signal.aborted) return;
      if (result.isOk()) {
        const files = result.value.files;
        // Use stable EMPTY_SET for empty results to avoid unnecessary re-renders
        if (files.length === 0) {
          if (prevRef.current.size !== 0) {
            prevRef.current = EMPTY_SET;
            setPaths(EMPTY_SET);
          }
          return;
        }
        const newPaths = new Set(files);
        const prev = prevRef.current;
        // Stable reference check
        if (newPaths.size !== prev.size || ![...newPaths].every((p) => prev.has(p))) {
          prevRef.current = newPaths;
          setPaths(newPaths);
        }
      }
    };

    fetchPaths();

    // Re-fetch periodically while the thread is running to pick up new files
    if (isRunning) {
      const interval = setInterval(fetchPaths, 5000);
      return () => {
        cancelled = true;
        abortRef.current?.abort();
        clearInterval(interval);
      };
    }

    return () => {
      cancelled = true;
      abortRef.current?.abort();
    };
  }, [threadId, isRunning, enabled]);

  return paths;
}

/**
 * The set of files this thread's agent actually modified, with diff stats.
 *
 * Cross-references the agent's touched-file tool calls against the working-tree
 * diff summary so callbacks only see files this thread changed (not unrelated
 * dirty files in the repo). Shared by the Activity pane and the in-chat
 * "changed files" completion summary.
 */
export function useThreadChangedFiles(enabled: boolean = true) {
  const threadId = useThreadId();
  const dirtySignal = useReviewPaneStore((s) => s.dirtySignal);
  const touchedPaths = useThreadTouchedPaths(enabled);
  const [files, setFiles] = useState<FileDiffSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [manualRefresh, setManualRefresh] = useState(0);
  const prevThreadIdRef = useRef(threadId);

  // Clear stale data immediately when switching threads
  useEffect(() => {
    if (threadId !== prevThreadIdRef.current) {
      prevThreadIdRef.current = threadId;
      setFiles([]);
      setLoading(!!threadId);
    }
  }, [threadId]);

  useEffect(() => {
    if (!threadId) {
      setFiles([]);
      return;
    }

    // No touched paths → no modified files to show; skip the diff API call entirely.
    // This prevents unnecessary loading flickers for idle threads.
    if (touchedPaths.size === 0) {
      setFiles([]);
      setLoading(false);
      return;
    }

    let cancelled = false;
    const timer = setTimeout(async () => {
      setLoading(true);
      let result;
      try {
        result = await api.getDiffSummary(threadId);
      } catch {
        if (!cancelled) setLoading(false);
        return;
      }
      if (!cancelled && result.isOk()) {
        // Filter to only files this thread's agent actually touched
        const filtered = result.value.files.filter((f) => {
          // Match by basename suffix — tool calls use absolute paths,
          // diff summary uses relative paths from the repo root.
          for (const tp of touchedPaths) {
            if (tp.endsWith(`/${f.path}`) || tp === f.path) return true;
          }
          return false;
        });
        setFiles(filtered);
      }
      if (!cancelled) setLoading(false);
    }, 300);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [threadId, dirtySignal, manualRefresh, touchedPaths]);

  const refresh = useCallback(() => setManualRefresh((n) => n + 1), []);

  return { files, loading, refresh };
}
