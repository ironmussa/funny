import type { Thread } from '@funny/shared';
import { useShallow } from 'zustand/react/shallow';

import { readThreadRow } from '@/data/threads/read';
import { useProjectStore } from '@/stores/project-store';
import { SCRATCH_TERMINAL_SCOPE_ID } from '@/stores/terminal-store';
import { useActiveThreadSelect, useThreadViewSelect } from '@/stores/thread-context';
import { useThreadStore } from '@/stores/thread-store';
import { readActiveThreadView, readThreadView } from '@/stores/thread-view';
import { useUIStore } from '@/stores/ui-store';

/**
 * Resolves the "terminal scope" — the id under which terminal tabs are
 * grouped and panel visibility is keyed. For a normal project thread this
 * is the project id; for a scratch thread there is no project, so we use
 * the synthetic {@link SCRATCH_TERMINAL_SCOPE_ID} sentinel and surface the
 * scratch thread id so the runner can derive the actual cwd.
 *
 * Also returns the selected thread's worktree path so a newly-created terminal
 * starts in that thread rather than at the project root. When no valid context
 * is selected, `scopeId` is null and callers should noop.
 */
export interface TerminalScope {
  scopeId: string | null;
  scratchThreadId: string | null;
  worktreePath: string | null;
}

type TerminalThread = Pick<Thread, 'id' | 'projectId' | 'isScratch' | 'worktreePath'>;

export function resolveTerminalScope({
  liveColumnsOpen,
  gridThread,
  selectedProjectId,
  activeThread,
}: {
  liveColumnsOpen: boolean;
  gridThread: TerminalThread | null;
  selectedProjectId: string | null;
  activeThread: TerminalThread | null;
}): TerminalScope {
  // Live columns have no thread route of their own. Their explicit selection
  // is therefore the terminal context, and an empty selection must not leak
  // the last project/thread visited in the regular single-thread view.
  if (liveColumnsOpen) {
    if (!gridThread) {
      return { scopeId: null, scratchThreadId: null, worktreePath: null };
    }
    if (gridThread.isScratch) {
      return {
        scopeId: SCRATCH_TERMINAL_SCOPE_ID,
        scratchThreadId: gridThread.id,
        worktreePath: null,
      };
    }
    return {
      scopeId: gridThread.projectId || null,
      scratchThreadId: null,
      worktreePath: gridThread.worktreePath ?? null,
    };
  }

  if (activeThread?.isScratch) {
    return {
      scopeId: SCRATCH_TERMINAL_SCOPE_ID,
      scratchThreadId: activeThread.id,
      worktreePath: null,
    };
  }

  const scopeId = selectedProjectId ?? activeThread?.projectId ?? null;
  return {
    scopeId,
    scratchThreadId: null,
    worktreePath: activeThread?.projectId === scopeId ? (activeThread.worktreePath ?? null) : null,
  };
}

function pickTerminalThread(thread: TerminalThread | null): TerminalThread | null {
  if (!thread) return null;
  return {
    id: thread.id,
    projectId: thread.projectId,
    isScratch: thread.isScratch,
    worktreePath: thread.worktreePath,
  };
}

export function useTerminalScope(): TerminalScope {
  const selectedProjectId = useProjectStore((s) => s.selectedProjectId);
  // Only the fields the scope needs: the full view changes on every streamed
  // message and re-rendered every terminal consumer.
  const activeThread = useActiveThreadSelect(useShallow(pickTerminalThread));
  const liveColumnsOpen = useUIStore((s) => s.liveColumnsOpen);
  const gridSelectedThreadId = useUIStore((s) => s.gridSelectedThreadId);
  const gridThread = useThreadViewSelect(gridSelectedThreadId, useShallow(pickTerminalThread));

  return resolveTerminalScope({
    liveColumnsOpen,
    gridThread,
    selectedProjectId,
    activeThread,
  });
}

/** Imperative version for non-React callers (effect callbacks, store actions). */
export function getTerminalScope(): TerminalScope {
  const selectedProjectId = useProjectStore.getState().selectedProjectId;
  const threadState = useThreadStore.getState();
  const { liveColumnsOpen, gridSelectedThreadId } = useUIStore.getState();
  const gridThread = gridSelectedThreadId
    ? (readThreadView(threadState, gridSelectedThreadId) ??
      readThreadRow(gridSelectedThreadId) ??
      null)
    : null;

  return resolveTerminalScope({
    liveColumnsOpen,
    gridThread,
    selectedProjectId,
    activeThread: readActiveThreadView(threadState),
  });
}
