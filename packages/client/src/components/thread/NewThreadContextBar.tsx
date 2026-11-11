import type { Project } from '@funny/shared';
import { SiGithub } from '@icons-pack/react-simple-icons';
import { FolderOpen, GitBranch, Globe, Loader2 } from 'lucide-react';
import type { ReactElement, ReactNode } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { PowerlineBar, type PowerlineSegmentData } from '@/components/ui/powerline-bar';
import { colorFromName, darkenHex } from '@/components/ui/project-chip';
import { useProjects } from '@/data/projects/hooks';
import { useBranchSwitch } from '@/hooks/use-branch-switch';
import { api } from '@/lib/api';
import { formatRemoteUrl, remoteUrlToBrowseUrl } from '@/lib/git-remote-url';
import { useBranchPickerStore } from '@/stores/branch-picker-store';

import { BranchPicker } from '../SearchablePicker';

interface NewThreadContextBarProps {
  /** Project the new thread targets. When omitted, only the branch picker (if any) renders. */
  projectId?: string;
}

/**
 * The new-thread context bar (project / repo / branch picker) rendered at the
 * top of the prompt input, next to the worktree switch. Self-contained: it
 * looks up the project, fetches the remote URL, and reads branch data from the
 * shared branch-picker store (populated by the prompt input's own effect).
 *
 * Used by both the main compose screen (`NewThreadInput`) and the kanban
 * "Add thread" dialog (`SlideUpPrompt`) so the bar stays consistent.
 */
export function NewThreadContextBar({ projectId }: NewThreadContextBarProps) {
  const projects = useProjects();
  const project = projectId ? projects.find((p) => p.id === projectId) : undefined;

  // ── Branch picker (shared store) ──
  const branches = useBranchPickerStore((s) => s.branches);
  const remoteBranches = useBranchPickerStore((s) => s.remoteBranches);
  const defaultBranch = useBranchPickerStore((s) => s.defaultBranch);
  const loading = useBranchPickerStore((s) => s.loading);
  const selectedBranch = useBranchPickerStore((s) => s.selectedBranch);
  const setSelectedBranch = useBranchPickerStore((s) => s.setSelectedBranch);
  const currentBranch = useBranchPickerStore((s) => s.currentBranch);

  // ── Branch switch on selection (checkout so ReviewPane shows accurate data) ──
  const { ensureBranch, branchSwitchDialog } = useBranchSwitch();
  const handleBranchChange = useCallback(
    async (branch: string) => {
      // Checkout first so the picker only moves once the branch is actually live.
      // ensureBranch is a no-op if already on the target branch, and returns
      // false if the user cancels the dirty-files dialog or the checkout fails.
      if (projectId && branch !== currentBranch) {
        const ok = await ensureBranch(projectId, branch);
        if (!ok) return;
      }
      setSelectedBranch(branch);
    },
    [setSelectedBranch, projectId, currentBranch, ensureBranch],
  );

  // ── Remote URL ──
  const remoteUrl = useProjectRemoteUrl(projectId);

  return (
    <>
      <NewThreadPowerline
        project={project}
        projectId={projectId}
        remoteUrl={remoteUrl}
        loading={loading}
        branchCount={branches.length}
        selectedBranch={selectedBranch}
        renderBranchTrigger={(trigger) => (
          <BranchPicker
            trigger={trigger}
            mobilePresentation="drawer"
            branches={branches}
            remoteBranches={remoteBranches}
            defaultBranch={defaultBranch}
            selected={selectedBranch}
            onChange={handleBranchChange}
            showCreateNew
            testId="new-thread-branch-picker"
          />
        )}
      />
      {branchSwitchDialog}
    </>
  );
}

function NewThreadPowerline({
  project,
  projectId,
  remoteUrl,
  loading,
  branchCount,
  selectedBranch,
  renderBranchTrigger,
}: {
  project?: Pick<Project, 'name' | 'color' | 'path'>;
  projectId?: string;
  remoteUrl: string | null;
  loading: boolean;
  branchCount: number;
  selectedBranch: string;
  renderBranchTrigger: (trigger: ReactElement) => ReactNode;
}) {
  const { t } = useTranslation();
  const baseColor = contextColor(project, projectId);
  const segments: PowerlineSegmentData[] = [];
  if (project) {
    segments.push({
      key: 'project',
      icon: FolderOpen,
      label: project.name,
      color: baseColor,
      tooltip: project.path,
    });
  }
  if (project && remoteUrl) {
    segments.push(repositorySegment(remoteUrl, baseColor));
  }
  if (branchCount > 0 || loading) {
    segments.push(
      loading
        ? branchSegment(t('common.loading'), LoadingBranchIcon, baseColor)
        : branchSegment(
            selectedBranch || t('newThread.selectBranch'),
            GitBranch,
            baseColor,
            renderBranchTrigger,
          ),
    );
  }

  return (
    <PowerlineBar
      segments={segments}
      size="md"
      className="max-w-full"
      data-testid="new-thread-powerline"
    />
  );
}

function contextColor(project?: Pick<Project, 'name' | 'color'>, projectId?: string) {
  return project?.color || colorFromName(project?.name || projectId || 'project');
}

/** The branch picker segment; without `renderTrigger` it is display-only (loading). */
function branchSegment(
  label: string,
  icon: PowerlineSegmentData['icon'],
  baseColor: string,
  renderTrigger?: PowerlineSegmentData['renderTrigger'],
): PowerlineSegmentData {
  return {
    key: 'branch',
    icon,
    label,
    color: darkenHex(baseColor, 0.15),
    testId: 'new-thread-branch-picker',
    renderTrigger,
  };
}

function repositorySegment(remoteUrl: string, baseColor: string): PowerlineSegmentData {
  const browseUrl = remoteUrlToBrowseUrl(remoteUrl);
  const label = formatRemoteUrl(remoteUrl);
  return {
    key: 'repository',
    icon: remoteUrl.includes('github.com') ? SiGithub : Globe,
    label,
    color: darkenHex(baseColor, 0.08),
    href: browseUrl ?? undefined,
    tooltip: browseUrl || label,
    testId: 'new-thread-repo-link',
  };
}

function LoadingBranchIcon({ className }: { className?: string }) {
  return <Loader2 className={`${className ?? ''} animate-spin`} />;
}

function useProjectRemoteUrl(projectId?: string) {
  const [remote, setRemote] = useState<{ projectId: string; url: string | null } | null>(null);
  const remoteUrl = remote && remote.projectId === projectId ? remote.url : null;
  useEffect(() => {
    if (!projectId) return;
    const controller = new AbortController();
    void (async () => {
      const result = await api.projectGetRemoteUrl(projectId, controller.signal);
      if (controller.signal.aborted) return;
      setRemote({ projectId, url: result.isOk() ? result.value.remoteUrl : null });
    })();
    return () => controller.abort();
  }, [projectId]);
  return remoteUrl;
}
