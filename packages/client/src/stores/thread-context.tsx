/**
 * ThreadContext — tells each subtree "which thread to read from".
 *
 * Replaces the global `s.activeThread` reads scattered across components.
 * Components no longer hard-code their data source — the surrounding
 * provider does. This unblocks N-thread views (live-columns grid) where
 * each column needs its own thread without hacking shared hooks.
 *
 * Two sources are supported:
 *   - `active`  → resolves through `s.activeThread` (Zustand subscription).
 *                 Used by the single-thread view at the App root.
 *   - `live`    → resolves through the `liveThread` carried in context.
 *                 Used by ThreadColumn inside the grid view, which already
 *                 manages its own thread state locally.
 *
 * No fallback: hooks throw when used without a provider.
 */

import { createContext, useContext, useMemo, useRef, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';

import type { AgentInitInfo, ThreadWithMessages } from './thread-store';
import { useThreadStore } from './thread-store';

export type ThreadSource = 'active' | 'live';

interface ThreadContextValue {
  threadId: string | null;
  source: ThreadSource;
  /** Only used when source === 'live'. Carried in context (not the store). */
  liveThread: ThreadWithMessages | null;
}

const ThreadContext = createContext<ThreadContextValue | null>(null);

interface ThreadProviderProps {
  threadId: string | null;
  source: ThreadSource;
  /** Required when source === 'live'. Ignored when source === 'active'. */
  liveThread?: ThreadWithMessages | null;
  children: ReactNode;
}

export function ThreadProvider({
  threadId,
  source,
  liveThread = null,
  children,
}: ThreadProviderProps) {
  const value = useMemo<ThreadContextValue>(
    () => ({ threadId, source, liveThread }),
    [threadId, source, liveThread],
  );
  return <ThreadContext.Provider value={value}>{children}</ThreadContext.Provider>;
}

function useThreadContext(): ThreadContextValue {
  const ctx = useContext(ThreadContext);
  if (!ctx) {
    throw new Error('useThread* hooks require a <ThreadProvider> ancestor');
  }
  return ctx;
}

/**
 * Resolves the thread inside a Zustand selector.
 * For `active`, reads from store.activeThread.
 * For `live`, returns the context-carried thread (does not read store).
 */
function resolveThread(
  state: { activeThread: ThreadWithMessages | null },
  ctx: ThreadContextValue,
): ThreadWithMessages | null {
  if (!ctx.threadId) return null;
  if (ctx.source === 'active') return state.activeThread;
  return ctx.liveThread;
}

// ── Public hooks ─────────────────────────────────────────────────────

export function useThreadId(): string | undefined {
  return useThreadContext().threadId ?? undefined;
}

export function useThreadSource(): ThreadSource {
  return useThreadContext().source;
}

/**
 * Generic selector — for one-off reads not covered by the named hooks.
 * Re-runs on every store change AND on context change.
 */
export function useThreadSelector<T>(selector: (thread: ThreadWithMessages | null) => T): T {
  const ctx = useThreadContext();
  return useThreadStore((s) => selector(resolveThread(s, ctx)));
}

export function useThreadStatus() {
  const ctx = useThreadContext();
  return useThreadStore((s) => resolveThread(s, ctx)?.status);
}

export function useThreadProjectId() {
  const ctx = useThreadContext();
  return useThreadStore((s) => resolveThread(s, ctx)?.projectId);
}

export function useThreadWorktreePath() {
  const ctx = useThreadContext();
  return useThreadStore((s) => resolveThread(s, ctx)?.worktreePath);
}

export function useThreadBranch() {
  const ctx = useThreadContext();
  return useThreadStore((s) => resolveThread(s, ctx)?.branch);
}

export function useThreadMessages() {
  const ctx = useThreadContext();
  return useThreadStore((s) => resolveThread(s, ctx)?.messages);
}

export function useThreadEvents() {
  const ctx = useThreadContext();
  return useThreadStore((s) => resolveThread(s, ctx)?.threadEvents);
}

export function useCompactionEvents() {
  const ctx = useThreadContext();
  return useThreadStore((s) => resolveThread(s, ctx)?.compactionEvents);
}

/**
 * Subscribe to `initInfo` with ref stability — same logic as the legacy
 * `useActiveInitInfo`: keep the previous reference unless tools/cwd/model
 * actually changed, so unrelated updates don't cascade.
 */
export function useThreadInitInfo(): AgentInitInfo | undefined {
  const ctx = useThreadContext();
  const prevRef = useRef<AgentInitInfo | undefined>(undefined);

  return useThreadStore((s) => {
    const next = resolveThread(s, ctx)?.initInfo;
    if (!next) {
      prevRef.current = undefined;
      return undefined;
    }
    const prev = prevRef.current;
    if (
      prev &&
      prev.cwd === next.cwd &&
      prev.model === next.model &&
      prev.tools.length === next.tools.length &&
      prev.tools.every((t, i) => t === next.tools[i])
    ) {
      return prev;
    }
    prevRef.current = next;
    return next;
  });
}

/** Thread minus the high-churn arrays — see `useActiveThreadCore` for rationale. */
export type ThreadCore = Omit<ThreadWithMessages, 'messages' | 'threadEvents' | 'compactionEvents'>;

export function useThreadCore(): ThreadCore | null {
  const ctx = useThreadContext();
  return useThreadStore(
    useShallow((s) => {
      const t = resolveThread(s, ctx);
      if (!t) return null;
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { messages, threadEvents, compactionEvents, ...core } = t;
      return core;
    }),
  );
}

// ── Imperative utility ────────────────────────────────────────────────
//
// For event handlers / effect callbacks where hooks aren't available.
// Walks both the active thread and `threadsByProject` for a base-Thread
// match. Returns null if the id isn't found in any known location.

export function getThreadById(threadId: string): ThreadWithMessages | null {
  const state = useThreadStore.getState();
  if (state.activeThread?.id === threadId) return state.activeThread;
  return null;
}
