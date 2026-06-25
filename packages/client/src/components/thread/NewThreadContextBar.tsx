import { SiGithub } from '@icons-pack/react-simple-icons';
import { FolderOpen, GitBranch, Globe, Loader2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useBranchSwitch } from '@/hooks/use-branch-switch';
import { api } from '@/lib/api';
import { useBranchPickerStore } from '@/stores/branch-picker-store';
import { useProjectStore } from '@/stores/project-store';

import { formatRemoteUrl, remoteUrlToBrowseUrl } from '../PromptInputUI';
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
  const projects = useProjectStore((s) => s.projects);
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
  const projectPath = useMemo(() => project?.path ?? '', [project?.path]);
  const [remoteUrl, setRemoteUrl] = useState<string | null>(null);
  useEffect(() => {
    if (projectPath) {
      (async () => {
        const result = await api.remoteUrl(projectPath);
        if (result.isOk()) setRemoteUrl(result.value.url);
        else setRemoteUrl(null);
      })();
    } else {
      setRemoteUrl(null);
    }
  }, [projectPath]);

  return (
    <>
      {project && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="flex max-w-[140px] min-w-0 items-center gap-1 md:max-w-[200px]">
              <FolderOpen className="size-4 shrink-0" />
              <span className="flex min-w-0 items-center font-medium">
                <span className="truncate">{project.name.slice(0, -8)}</span>
                <span className="shrink-0">{project.name.slice(-8)}</span>
              </span>
            </span>
          </TooltipTrigger>
          <TooltipContent className="max-w-[min(28rem,calc(100vw-2rem))] break-all">
            {project.name}
          </TooltipContent>
        </Tooltip>
      )}
      {project && remoteUrl && (
        <>
          <span className="text-muted-foreground/40 shrink-0">/</span>
          {(() => {
            const browseUrl = remoteUrlToBrowseUrl(remoteUrl);
            const Icon = remoteUrl.includes('github.com') ? SiGithub : Globe;
            const formatted = formatRemoteUrl(remoteUrl);
            const content = (
              <>
                <Icon className="size-4 shrink-0" />
                <span className="flex min-w-0 items-center font-medium">
                  <span className="truncate">{formatted.slice(0, -8)}</span>
                  <span className="shrink-0">{formatted.slice(-8)}</span>
                </span>
              </>
            );
            return browseUrl ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <a
                    href={browseUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="hover:bg-muted hover:text-foreground flex max-w-[180px] min-w-0 items-center gap-1 rounded px-1 py-0.5 transition-colors md:max-w-[280px]"
                    data-testid="new-thread-repo-link"
                  >
                    {content}
                  </a>
                </TooltipTrigger>
                <TooltipContent className="max-w-[min(32rem,calc(100vw-2rem))] font-mono break-all">
                  {browseUrl}
                </TooltipContent>
              </Tooltip>
            ) : (
              <span className="flex max-w-[180px] min-w-0 items-center gap-1 md:max-w-[280px]">
                {content}
              </span>
            );
          })()}
        </>
      )}
      {(branches.length > 0 || loading) && (
        <>
          <span className="text-muted-foreground/40">/</span>
          {loading ? (
            <span className="flex items-center gap-1">
              <GitBranch className="size-4 shrink-0" />
              <Loader2 className="icon-base animate-spin" />
            </span>
          ) : (
            <BranchPicker
              branches={branches}
              remoteBranches={remoteBranches}
              defaultBranch={defaultBranch}
              selected={selectedBranch}
              onChange={handleBranchChange}
              showCreateNew
              testId="new-thread-branch-picker"
              triggerClassName="flex max-w-[300px] items-center gap-1.5 truncate rounded px-1.5 py-0.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-hidden [&_svg]:h-4 [&_svg]:w-4"
            />
          )}
        </>
      )}
      {branchSwitchDialog}
    </>
  );
}
