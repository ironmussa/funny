import { useEffect, useRef } from 'react';
import { useShallow } from 'zustand/react/shallow';

import { useProjectById, useProjectCurrentBranch } from '@/data/projects/hooks';
import { useThreadById } from '@/data/threads/hooks';
import { useActiveThreadId } from '@/hooks/use-active-thread-id';
import { createClientLogger } from '@/lib/client-logger';
import { cleanThreadTitle } from '@/lib/thread-title';
import { isScratch } from '@/lib/thread-variant';
import { resolveLocalThreadBranch, resolveThreadBranch } from '@/lib/utils';
import { useProjectStore } from '@/stores/project-store';
import { useThreadStore, type ThreadState } from '@/stores/thread-store';

const log = createClientLogger('document-title');

type ThreadLike = {
  id?: string;
  isScratch?: boolean;
  mode?: string;
  title?: string | null;
  projectId?: string;
  branch?: string | null;
  baseBranch?: string | null;
  worktreePath?: string | null;
};

/** Pure title builder — exported for tests. */
export function formatDocumentTitle(opts: {
  projectName?: string;
  branch?: string;
  scratchTitle?: string | null;
  isScratchThread?: boolean;
}): string {
  if (opts.isScratchThread) {
    // Titles of threads created with attachments start with the
    // `<referenced-files>` block — show the prompt text, like the sidebar.
    const title = opts.scratchTitle ? cleanThreadTitle(opts.scratchTitle).displayTitle.trim() : '';
    return title ? `${title} — funny` : 'funny';
  }
  if (opts.projectName && opts.branch) {
    return `${opts.projectName} [${opts.branch}] — funny`;
  }
  if (opts.projectName) {
    return `${opts.projectName} — funny`;
  }
  return 'funny';
}

/** Branch label for the tab title — uses thread metadata, not git cwd state. */
export function branchForDocumentTitle(thread: ThreadLike | null | undefined): string | undefined {
  if (!thread || isScratch(thread)) return undefined;
  if (thread.mode === 'worktree') return resolveThreadBranch(thread);
  return resolveLocalThreadBranch(thread);
}

/** Project shown in the title: the focused (non-scratch) thread's, else the selection. */
function titleProjectId(
  thread: ThreadLike | undefined,
  selectedProjectId: string | null,
): string | undefined {
  return thread?.projectId || selectedProjectId || undefined;
}

/**
 * Thread focused → its own branch only (stable, no async cwd race).
 * No thread → the project's current cwd branch.
 */
function titleBranch(
  thread: ThreadLike | undefined,
  cwdBranch: string | undefined,
): { branch: string | undefined; branchSource: 'thread' | 'cwd' | 'none' } {
  if (thread) return { branch: branchForDocumentTitle(thread), branchSource: 'thread' };
  return { branch: cwdBranch, branchSource: cwdBranch ? 'cwd' : 'none' };
}

/**
 * Sync `document.title` to the focused thread / project.
 *
 * The branch label is derived ONLY from the focused thread's own metadata
 * (same source as ThreadPowerline), never from the project's branch listing.
 * The cwd branch lags a thread switch: `selectedThreadId` updates
 * synchronously on click, but the project checkout runs async, so the listing
 * still holds the *previous* thread's branch for a beat. Falling back to it
 * made the tab title flash the old branch then the new one on every
 * back-and-forth switch. The listing is only used when no thread is focused
 * (a project is selected but no thread is open).
 */
/**
 * Only the loaded payload's fields the title reads. The payload object is
 * replaced on every streaming flush (messages, tool calls), so selecting it
 * whole re-rendered the app root at stream rate; with `useShallow` the
 * selection only changes when one of these fields does. Exported for tests.
 */
export function pickTitleThread(s: Pick<ThreadState, 'activeThread'>): ThreadLike | null {
  const t = s.activeThread;
  if (!t) return null;
  return {
    id: t.id,
    isScratch: t.isScratch,
    mode: t.mode,
    title: t.title,
    projectId: t.projectId,
    branch: t.branch,
    baseBranch: t.baseBranch,
    worktreePath: t.worktreePath,
  };
}

/** The URL-focused thread's row, falling back to the loaded right-pane payload. */
function useFocusThread(): ThreadLike | null {
  const activeThreadId = useActiveThreadId();
  const listedThread = useThreadById(activeThreadId);
  const loadedThread = useThreadStore(useShallow(pickTitleThread));
  return listedThread ?? loadedThread;
}

export function useDocumentTitle(): void {
  const selectedProjectId = useProjectStore((s) => s.selectedProjectId);
  // Focused thread follows the URL, not the async selectedThreadId — the latter
  // lagged a switch and flashed the previous title for a beat.
  const focusThread = useFocusThread();

  const scratch = isScratch(focusThread);
  const titleThread = scratch ? undefined : (focusThread ?? undefined);

  const projectId = titleProjectId(titleThread, selectedProjectId);
  const projectName = useProjectById(projectId)?.name;
  const cwdBranch = useProjectCurrentBranch(projectId);
  const { branch, branchSource } = titleBranch(titleThread, cwdBranch);

  const focusThreadId = focusThread?.id;
  const focusThreadMode = focusThread?.mode;
  const prevTitleRef = useRef<string | null>(null);

  useEffect(() => {
    const title = formatDocumentTitle({
      projectName,
      branch,
      scratchTitle: scratch ? focusThread?.title : undefined,
      isScratchThread: scratch,
    });
    document.title = title;

    // Permanent debug trace of every title transition — enable at runtime with
    // `__funnyLog.setNamespaceLevel('document-title', 'debug')` to diagnose the
    // tab-title flicker on thread switches (which branch/source each change
    // came from). Off in prod by default; logs only on an actual title change.
    if (title !== prevTitleRef.current) {
      log.debug('title changed', {
        from: prevTitleRef.current,
        to: title,
        branch: branch ?? null,
        branchSource,
        focusThreadId: focusThreadId ?? null,
        focusThreadMode: focusThreadMode ?? null,
        projectName: projectName ?? null,
        scratch,
      });
      prevTitleRef.current = title;
    }
  }, [
    projectName,
    branch,
    branchSource,
    scratch,
    focusThread?.title,
    focusThreadId,
    focusThreadMode,
  ]);
}
