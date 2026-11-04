/**
 * ThreadContext — tells each subtree "which thread to read from".
 *
 * Resolves the loaded payload from the unified `threadDataById` map and
 * puts the thread's collection row on top (`thread-view.ts`), so row fields
 * (status, title, …) are always the canonical ones. Both the right pane and
 * the live-columns grid use the same provider with the same resolution path —
 * the only difference is which `threadId` the provider carries.
 *
 * Hooks throw when used without a provider.
 */

import type { Thread } from '@funny/shared';
import { createContext, useContext, useMemo, type Context, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';

import { useThreadById } from '@/data/threads/hooks';

import type { ThreadWithMessages } from './thread-store';
import { useThreadStore } from './thread-store';
import { mergeThreadView, readThreadView } from './thread-view';

interface ThreadContextValue {
  threadId: string | null;
}

// Keep the context object stable across Vite hot replacements. Otherwise an
// already-mounted provider can hold the previous module's context while newly
// evaluated hooks read from a fresh one and incorrectly report no ancestor.
const ThreadContext =
  (import.meta.hot?.data?.threadContext as Context<ThreadContextValue | null> | undefined) ??
  createContext<ThreadContextValue | null>(null);

if (import.meta.hot?.data) {
  import.meta.hot.data.threadContext = ThreadContext;
}

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

/** Resolves the thread view (payload + row) inside a Zustand selector. */
function resolveThread(
  state: { threadDataById: Record<string, ThreadWithMessages> },
  ctx: ThreadContextValue,
  row: Thread | undefined,
): ThreadWithMessages | null {
  if (!ctx.threadId) return null;
  return mergeThreadView(state.threadDataById[ctx.threadId], row);
}

/** Context plus the live row, so row changes re-render consumers. */
function useThreadSource(): { ctx: ThreadContextValue; row: Thread | undefined } {
  const ctx = useThreadContext();
  return { ctx, row: useThreadById(ctx.threadId) };
}

// ── Public hooks ─────────────────────────────────────────────────────

export function useThreadId(): string | undefined {
  return useThreadContext().threadId ?? undefined;
}

/**
 * Generic selector — for one-off reads not covered by the named hooks.
 * Re-runs on every store change, row change AND context change.
 */
export function useThreadSelector<T>(selector: (thread: ThreadWithMessages | null) => T): T {
  const { ctx, row } = useThreadSource();
  return useThreadStore((s) => selector(resolveThread(s, ctx, row)));
}

export function useThreadStatus() {
  const { ctx, row } = useThreadSource();
  return useThreadStore((s) => resolveThread(s, ctx, row)?.status);
}

export function useThreadProjectId() {
  const { ctx, row } = useThreadSource();
  return useThreadStore((s) => resolveThread(s, ctx, row)?.projectId);
}

export function useThreadWorktreePath() {
  const { ctx, row } = useThreadSource();
  return useThreadStore((s) => resolveThread(s, ctx, row)?.worktreePath);
}

export function useThreadBranch() {
  const { ctx, row } = useThreadSource();
  return useThreadStore((s) => resolveThread(s, ctx, row)?.branch);
}

export function useThreadMessages() {
  const ctx = useThreadContext();
  return useThreadStore((s) =>
    ctx.threadId ? s.threadDataById[ctx.threadId]?.messages : undefined,
  );
}

export function useThreadEvents() {
  const ctx = useThreadContext();
  return useThreadStore((s) =>
    ctx.threadId ? s.threadDataById[ctx.threadId]?.threadEvents : undefined,
  );
}

export function useCompactionEvents() {
  const ctx = useThreadContext();
  return useThreadStore((s) =>
    ctx.threadId ? s.threadDataById[ctx.threadId]?.compactionEvents : undefined,
  );
}

/** Thread minus the high-churn arrays, so updates to messages/events don't re-render core consumers. */
export type ThreadCore = Omit<ThreadWithMessages, 'messages' | 'threadEvents' | 'compactionEvents'>;

export function useThreadCore(): ThreadCore | null {
  const { ctx, row } = useThreadSource();
  return useThreadStore(
    useShallow((s) => {
      const t = resolveThread(s, ctx, row);
      if (!t) return null;
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { messages, threadEvents, compactionEvents, ...core } = t;
      return core;
    }),
  );
}

// ── Hooks outside a ThreadProvider ───────────────────────────────────

/** The open thread (`activeThread`) with current row fields. */
export function useActiveThreadView(): ThreadWithMessages | null {
  const row = useThreadById(useThreadStore((s) => s.activeThread?.id));
  return useThreadStore((s) => mergeThreadView(s.activeThread, row));
}

/**
 * A thread by id: its loaded payload (right pane or live column) with current
 * row fields, or just its row when the payload is not loaded.
 */
export function useThreadViewById(
  threadId: string | null | undefined,
): ThreadWithMessages | Thread | null {
  const row = useThreadById(threadId);
  const view = useThreadStore((s) =>
    threadId ? mergeThreadView(s.threadDataById[threadId], row) : null,
  );
  return view ?? row ?? null;
}

// ── Imperative utility ────────────────────────────────────────────────
//
// For event handlers / effect callbacks where hooks aren't available.
// Returns the loaded payload with current row fields, or null when the
// thread's payload is not loaded.

export function getThreadById(threadId: string): ThreadWithMessages | null {
  return readThreadView(useThreadStore.getState(), threadId);
}
