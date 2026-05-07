import { useEffect, useRef } from 'react';

import { useBranchSwitch } from '@/hooks/use-branch-switch';
import { createClientLogger } from '@/lib/client-logger';
import { resolveThreadBranch } from '@/lib/utils';
import { useThreadCore } from '@/stores/thread-context';

const log = createClientLogger('useActiveThreadBranchSync');

/**
 * Keep the working directory branch aligned with the active local-mode thread.
 *
 * When the user opens a thread by deep-link (e.g. Ctrl+click → new tab, or
 * cold-loading the URL), the sidebar's pre-navigation `ensureBranch` is
 * skipped. This hook closes that gap by re-running the same check whenever
 * the active local thread changes.
 *
 * Worktree threads are skipped — they live on their own branch in their own
 * directory and never need a project-level checkout.
 */
export function useActiveThreadBranchSync() {
  const activeThread = useThreadCore();
  const { ensureBranch, branchSwitchDialog } = useBranchSwitch();
  const lastSyncedRef = useRef<string | null>(null);

  useEffect(() => {
    if (!activeThread) {
      lastSyncedRef.current = null;
      return;
    }
    if (activeThread.mode !== 'local') return;
    if (lastSyncedRef.current === activeThread.id) return;

    const branch = resolveThreadBranch(activeThread);
    if (!branch || !activeThread.projectId) return;

    lastSyncedRef.current = activeThread.id;
    ensureBranch(activeThread.projectId, branch).catch((err) => {
      log.error('ensureBranch failed', { threadId: activeThread.id, err });
    });
  }, [activeThread, ensureBranch]);

  return branchSwitchDialog;
}
