import { useEffect, useRef } from 'react';

import { useBranchSwitch } from '@/hooks/use-branch-switch';
import { createClientLogger } from '@/lib/client-logger';
import { resolveLocalThreadBranch } from '@/lib/utils';
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
  /** projectId:branch — skip re-checkout when switching threads on the same branch. */
  const lastSyncedBranchKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!activeThread) {
      lastSyncedBranchKeyRef.current = null;
      return;
    }
    if (activeThread.mode !== 'local') return;

    const branch = resolveLocalThreadBranch(activeThread);
    if (!branch || !activeThread.projectId) return;

    const syncKey = `${activeThread.projectId}:${branch}`;
    if (lastSyncedBranchKeyRef.current === syncKey) return;

    lastSyncedBranchKeyRef.current = syncKey;
    ensureBranch(activeThread.projectId, branch).catch((err) => {
      log.error('ensureBranch failed', { threadId: activeThread.id, err });
    });
  }, [activeThread, ensureBranch]);

  return branchSwitchDialog;
}
