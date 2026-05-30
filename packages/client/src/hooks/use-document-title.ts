import { useEffect, useRef } from 'react';

import { createClientLogger } from '@/lib/client-logger';
import { isScratch } from '@/lib/thread-variant';
import { resolveLocalThreadBranch, resolveThreadBranch } from '@/lib/utils';
import { useProjectStore } from '@/stores/project-store';
import { useThreadStore } from '@/stores/thread-store';

const log = createClientLogger('document-title');

type ThreadLike = {
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
    const title = opts.scratchTitle?.trim();
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

/**
 * Sync `document.title` to the focused thread / project.
 *
 * The branch label is derived ONLY from the focused thread's own metadata
 * (same source as ThreadPowerline), never from `branchByProject`. The cwd
 * branch lags a thread switch: `selectedThreadId` updates synchronously on
 * click, but the project checkout runs async, so `branchByProject` still
 * holds the *previous* thread's branch for a beat. Falling back to it made
 * the tab title flash the old branch then the new one on every back-and-forth
 * switch. `branchByProject` is only used when no thread is focused (a project
 * is selected but no thread is open).
 */
export function useDocumentTitle(): void {
  const selectedProjectId = useProjectStore((s) => s.selectedProjectId);
  const focusThread = useThreadStore((s) => {
    const id = s.selectedThreadId;
    if (id && s.threadsById[id]) return s.threadsById[id];
    return s.activeThread;
  });

  const scratch = isScratch(focusThread);
  const hasThread = !!focusThread && !scratch;

  const projectId = hasThread
    ? focusThread.projectId || selectedProjectId || undefined
    : selectedProjectId || undefined;

  const projectName = useProjectStore((s) =>
    projectId ? s.projects.find((p) => p.id === projectId)?.name : undefined,
  );
  const cwdBranch = useProjectStore((s) => (projectId ? s.branchByProject[projectId] : undefined));

  // Thread focused → its own branch only (stable, no async cwd race).
  // No thread → project's current cwd branch.
  const branch = hasThread ? branchForDocumentTitle(focusThread) : cwdBranch;
  const branchSource = hasThread ? 'thread' : cwdBranch ? 'cwd' : 'none';

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
