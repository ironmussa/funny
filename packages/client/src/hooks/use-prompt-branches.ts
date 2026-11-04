import type { Project } from '@funny/shared';
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';

import { useBranchSwitch } from '@/hooks/use-branch-switch';
import { api } from '@/lib/api';
import { useBranchPickerStore } from '@/stores/branch-picker-store';
import { useUIStore } from '@/stores/ui-store';

interface FollowUpBranchData {
  projectId: string;
  branches: string[];
  remoteBranches: string[];
  defaultBranch: string | null;
  currentBranch: string | null;
}

/**
 * Initial follow-up branch selection when no explicit base branch is set:
 * project default (if it exists), then the repo default, the current branch,
 * or the first branch. Undefined means "leave the selection unchanged".
 */
function pickFollowUpBranch(
  projectDefaultBranch: string | undefined,
  branchList: string[],
  cache: FollowUpBranchData | null,
): string | undefined {
  if (projectDefaultBranch && branchList.includes(projectDefaultBranch)) {
    return projectDefaultBranch;
  }
  return cache?.defaultBranch || cache?.currentBranch || branchList[0];
}

/** Branch list + selection for follow-up messages on an existing thread. */
function useFollowUpBranches({
  isNewThread,
  selectedProjectId,
  projects,
  activeThreadBaseBranch,
}: {
  isNewThread: boolean;
  selectedProjectId: string | null | undefined;
  projects: Project[];
  activeThreadBaseBranch: string | null | undefined;
}) {
  const [followUpBranches, setFollowUpBranches] = useState<string[]>([]);
  const [followUpRemoteBranches, setFollowUpRemoteBranches] = useState<string[]>([]);
  const [followUpDefaultBranch, setFollowUpDefaultBranch] = useState<string | null>(null);
  const [followUpCurrentBranch, setFollowUpCurrentBranch] = useState<string | null>(null);
  const [followUpSelectedBranch, setFollowUpSelectedBranch] = useState<string>('');
  const followUpBranchCacheRef = useRef<FollowUpBranchData | null>(null);

  const applyBranchData = (data: FollowUpBranchData) => {
    setFollowUpBranches(data.branches);
    setFollowUpRemoteBranches(data.remoteBranches);
    setFollowUpDefaultBranch(data.defaultBranch);
    setFollowUpCurrentBranch(data.currentBranch);
  };
  const resetBranches = () => {
    setFollowUpBranches([]);
    setFollowUpCurrentBranch(null);
  };

  // Fetch follow-up branches — only refetch when the project changes.
  // Branch selection is updated separately when activeThreadBaseBranch changes.
  useEffect(() => {
    let cancelled = false;
    if (isNewThread || !selectedProjectId) {
      resetBranches();
      followUpBranchCacheRef.current = null;
      return;
    }
    const cached = followUpBranchCacheRef.current;
    if (cached?.projectId === selectedProjectId) {
      applyBranchData(cached);
      return;
    }
    void api.listBranches(selectedProjectId).then((result) => {
      if (cancelled) return;
      if (result.isErr()) {
        resetBranches();
        return;
      }
      const data: FollowUpBranchData = {
        projectId: selectedProjectId,
        branches: result.value.branches,
        remoteBranches: result.value.remoteBranches ?? [],
        defaultBranch: result.value.defaultBranch,
        currentBranch: result.value.currentBranch,
      };
      followUpBranchCacheRef.current = data;
      applyBranchData(data);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isNewThread, selectedProjectId]);

  // Update selection when the active thread's base branch changes (no network call)
  useEffect(() => {
    if (isNewThread || !selectedProjectId) return;
    const cache = followUpBranchCacheRef.current;
    const next =
      activeThreadBaseBranch ||
      pickFollowUpBranch(
        projects.find((p) => p.id === selectedProjectId)?.defaultBranch,
        cache?.branches ?? followUpBranches,
        cache,
      );
    if (next !== undefined) setFollowUpSelectedBranch(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isNewThread, selectedProjectId, activeThreadBaseBranch]);

  return {
    followUpBranches,
    followUpRemoteBranches,
    followUpDefaultBranch,
    followUpCurrentBranch,
    followUpSelectedBranch,
    setFollowUpSelectedBranch,
  };
}

/**
 * Branch state for the composer: the new-thread branch picker, follow-up
 * branch selection, and checkout preflight via the shared branch-switch dialog.
 */
export function usePromptBranches({
  isNewThread,
  effectiveProjectId,
  selectedProjectId,
  projects,
  activeThreadBaseBranch,
}: {
  isNewThread: boolean;
  effectiveProjectId: string | null | undefined;
  selectedProjectId: string | null | undefined;
  projects: Project[];
  activeThreadBaseBranch: string | null | undefined;
}) {
  const selectedBranch = useBranchPickerStore((s) => s.selectedBranch);
  const gitCurrentBranch = useBranchPickerStore((s) => s.currentBranch);
  const fetchBranches = useBranchPickerStore((s) => s.fetchBranches);
  const newThreadBaseBranch = useUIStore((s) => s.newThreadBaseBranch);
  const projectDefaultBranch = effectiveProjectId
    ? projects.find((p) => p.id === effectiveProjectId)?.defaultBranch
    : undefined;

  // fetchBranches is gated on isNewThread, where the resolved project collapses
  // to the selected one.
  useEffect(() => {
    if (isNewThread && effectiveProjectId) {
      fetchBranches(effectiveProjectId, projectDefaultBranch, newThreadBaseBranch);
    }
  }, [isNewThread, effectiveProjectId, projectDefaultBranch, newThreadBaseBranch, fetchBranches]);

  const { setFollowUpSelectedBranch, ...followUp } = useFollowUpBranches({
    isNewThread,
    selectedProjectId,
    projects,
    activeThreadBaseBranch,
  });

  const { ensureBranch, branchSwitchDialog } = useBranchSwitch();

  const handleCheckoutPreflight = useCallback(
    async (branch: string): Promise<boolean> => {
      if (!effectiveProjectId || !gitCurrentBranch || branch === gitCurrentBranch) return true;
      return ensureBranch(effectiveProjectId, branch);
    },
    [effectiveProjectId, gitCurrentBranch, ensureBranch],
  );

  // Checkout on follow-up branch change so ReviewPane refreshes immediately.
  // Wait for ensureBranch to confirm before updating the picker — otherwise
  // cancelling the dirty-files dialog leaves the UI on a branch we never switched to.
  const handleFollowUpBranchChange = useCallback(
    async (branch: string) => {
      if (effectiveProjectId && branch !== gitCurrentBranch) {
        const ok = await ensureBranch(effectiveProjectId, branch);
        if (!ok) return;
      }
      setFollowUpSelectedBranch(branch);
    },
    [effectiveProjectId, gitCurrentBranch, ensureBranch, setFollowUpSelectedBranch],
  );

  return {
    selectedBranch,
    ...followUp,
    handleFollowUpBranchChange,
    handleCheckoutPreflight,
    branchSwitchDialog: branchSwitchDialog as ReactElement | null,
  };
}
