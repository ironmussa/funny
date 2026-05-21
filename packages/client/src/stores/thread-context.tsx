/**
 * ThreadContext — tells each subtree "which thread to read from".
 *
 * Resolves through the unified `threadDataById` map in the store. Both the
 * right pane and the live-columns grid use the same provider with the same
 * resolution path — the only difference is which `threadId` the provider
 * carries. No `source` distinction, no externally-supplied payload.
 *
 * Hooks throw when used without a provider.
 */

import { createContext, useContext, useMemo, useRef, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';

import type { AgentInitInfo, ThreadWithMessages } from './thread-store';
import { useThreadStore } from './thread-store';

interface ThreadContextValue {
  threadId: string | null;
}

const ThreadContext = createContext<ThreadContextValue | null>(null);

interface ThreadProviderProps {
  threadId: string | null;
  children: ReactNode;
}

export function ThreadProvider({ threadId, children }: ThreadProviderProps) {
  const value = useMemo<ThreadContextValue>(() => ({ threadId }), [threadId]);
  return <ThreadContext.Provider value={value}>{children}</ThreadContext.Provider>;
}

function useThreadContext(): ThreadContextValue {
  const ctx = useContext(ThreadContext);
  if (!ctx) {
    throw new Error('useThread* hooks require a <ThreadProvider> ancestor');
  }
  return ctx;
}

/** Resolves the thread payload inside a Zustand selector. */
function resolveThread(
  state: { threadDataById: Record<string, ThreadWithMessages> },
  ctx: ThreadContextValue,
): ThreadWithMessages | null {
  if (!ctx.threadId) return null;
  return state.threadDataById[ctx.threadId] ?? null;
}

// ── Public hooks ─────────────────────────────────────────────────────

export function useThreadId(): string | undefined {
  return useThreadContext().threadId ?? undefined;
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
 * Subscribe to `initInfo` with ref stability — keep the previous reference
 * unless tools/cwd/model actually changed, so unrelated updates don't
 * cascade.
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
// Returns the loaded payload if present, otherwise the base Thread row
// from the sidebar index, otherwise null.

export function getThreadById(threadId: string): ThreadWithMessages | null {
  const state = useThreadStore.getState();
  return state.threadDataById[threadId] ?? null;
}
