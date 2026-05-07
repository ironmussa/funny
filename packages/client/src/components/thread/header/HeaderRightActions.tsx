import {
  ArrowDown,
  ArrowUp,
  FlaskConical,
  FolderTree,
  GitCompare,
  Globe,
  Terminal,
} from 'lucide-react';
import { startTransition, useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation } from 'react-router-dom';

import { DiffStats } from '@/components/DiffStats';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { usePreviewWindow } from '@/hooks/use-preview-window';
import { useStableNavigate } from '@/hooks/use-stable-navigate';
import { buildPath } from '@/lib/url';
import { cn } from '@/lib/utils';
import { useGitStatusForThread, useGitStatusStore } from '@/stores/git-status-store';
import { useProjectStore } from '@/stores/project-store';
import { useTerminalStore } from '@/stores/terminal-store';
import {
  useThreadBranch,
  useThreadId,
  useThreadProjectId,
  useThreadSelector,
  useThreadStatus,
  useThreadWorktreePath,
} from '@/stores/thread-context';
import { useUIStore } from '@/stores/ui-store';

import { MoreActionsMenu } from './MoreActionsMenu';
import { StageSelectorBadge } from './StageSelectorBadge';
import { StartupCommandsPopover } from './StartupCommandsPopover';

export function HeaderRightActions() {
  const { t } = useTranslation();
  const navigate = useStableNavigate();
  const location = useLocation();
  const updatePanelParam = useCallback(
    (panel: string | null) => {
      const params = new URLSearchParams(location.search);
      if (panel) {
        params.set('panel', panel);
      } else {
        params.delete('panel');
      }
      if (!panel || panel !== 'review') {
        params.delete('tab');
      }
      const search = params.toString();
      navigate(`${location.pathname}${search ? `?${search}` : ''}`, { replace: true });
    },
    [location.pathname, location.search, navigate],
  );
  const activeThreadId = useThreadId();
  const activeThreadProjectId = useThreadProjectId();
  const activeThreadStage = useThreadSelector((t) => t?.stage);
  const activeThreadStatus = useThreadStatus();
  const activeThreadWorktreePath = useThreadWorktreePath();
  const activeThreadBranch = useThreadBranch();
  const selectedProjectId = useProjectStore((s) => s.selectedProjectId);
  const project = useProjectStore((s) =>
    s.projects.find((p) => p.id === (activeThreadProjectId ?? selectedProjectId)),
  );
  const projectId = activeThreadProjectId ?? selectedProjectId;
  const reviewPaneOpen = useUIStore((s) => s.reviewPaneOpen);
  const setReviewPaneOpen = useUIStore((s) => s.setReviewPaneOpen);
  const setTestRunnerOpen = useUIStore((s) => s.setTestRunnerOpen);
  const testRunnerOpen = useUIStore((s) => s.testRunnerOpen);
  const setFilesPaneOpen = useUIStore((s) => s.setFilesPaneOpen);
  const rightPaneTab = useUIStore((s) => s.rightPaneTab);
  const { openPreview, isTauri } = usePreviewWindow();
  const toggleTerminalPanel = useTerminalStore((s) => s.togglePanel);
  const panelVisibleByProject = useTerminalStore((s) => s.panelVisibleByProject);
  const setPanelVisible = useTerminalStore((s) => s.setPanelVisible);
  const addTab = useTerminalStore((s) => s.addTab);
  const tabs = useTerminalStore((s) => s.tabs);
  const terminalPanelVisible = selectedProjectId
    ? (panelVisibleByProject[selectedProjectId] ?? false)
    : false;
  const gitStatus = useGitStatusForThread(activeThreadId ?? undefined);
  const projectGitStatus = useGitStatusStore((s) =>
    !activeThreadId && selectedProjectId ? s.statusByProject[selectedProjectId] : undefined,
  );
  const fetchForThread = useGitStatusStore((s) => s.fetchForThread);
  const fetchProjectStatus = useGitStatusStore((s) => s.fetchProjectStatus);
  useEffect(() => {
    if (activeThreadId) {
      fetchForThread(activeThreadId);
    } else if (selectedProjectId) {
      fetchProjectStatus(selectedProjectId);
    }
  }, [activeThreadId, selectedProjectId, fetchForThread, fetchProjectStatus]);
  const effectiveGitStatus = gitStatus ?? projectGitStatus;
  const showGitStats =
    effectiveGitStatus &&
    (effectiveGitStatus.linesAdded > 0 ||
      effectiveGitStatus.linesDeleted > 0 ||
      effectiveGitStatus.dirtyFileCount > 0);
  const unpushedCommitCount = effectiveGitStatus?.unpushedCommitCount ?? 0;
  const unpulledCommitCount = effectiveGitStatus?.unpulledCommitCount ?? 0;
  const hasPendingPush = unpushedCommitCount > 0;
  const hasPendingPull = unpulledCommitCount > 0;
  const runningWithPort = tabs.filter(
    (tab) => tab.projectId === projectId && tab.commandId && tab.alive && tab.port,
  );

  const toggleReview = () =>
    startTransition(() => {
      if (reviewPaneOpen && rightPaneTab === 'review') {
        setReviewPaneOpen(false);
        updatePanelParam(null);
      } else {
        setReviewPaneOpen(true);
        updatePanelParam('review');
      }
    });

  const handleTerminalClick = () => {
    if (!selectedProjectId) return;
    const projectTabs = tabs.filter((tab) => tab.projectId === selectedProjectId);
    if (projectTabs.length === 0 && !terminalPanelVisible) {
      const cwd = activeThreadWorktreePath || project?.path || 'C:\\';
      addTab({
        id: crypto.randomUUID(),
        label: 'Terminal 1',
        cwd,
        alive: true,
        projectId: selectedProjectId,
        type: isTauri ? undefined : 'pty',
      });
      setPanelVisible(selectedProjectId, true);
    } else {
      toggleTerminalPanel(selectedProjectId);
    }
  };

  if (activeThreadStatus === 'setting_up') return null;

  return (
    <div className="flex flex-shrink-0 items-center gap-2">
      {activeThreadId && activeThreadStage && activeThreadStage !== 'archived' && (
        <StageSelectorBadge
          threadId={activeThreadId!}
          projectId={activeThreadProjectId!}
          stage={activeThreadStage}
        />
      )}
      <StartupCommandsPopover
        projectId={projectId!}
        threadId={activeThreadWorktreePath ? activeThreadId : undefined}
        worktreeBranch={activeThreadWorktreePath ? activeThreadBranch : undefined}
      />
      {runningWithPort.length > 0 && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              data-testid="header-preview"
              variant="ghost"
              size="icon-sm"
              onClick={() => {
                const cmd = runningWithPort[0];
                openPreview({
                  commandId: cmd.commandId!,
                  projectId: cmd.projectId,
                  port: cmd.port!,
                  commandLabel: cmd.label,
                });
              }}
              className="text-status-info hover:text-status-info/80"
            >
              <Globe className="icon-base" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t('preview.openPreview')}</TooltipContent>
        </Tooltip>
      )}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={handleTerminalClick}
            data-testid="header-toggle-terminal"
            className={terminalPanelVisible ? 'text-foreground' : 'text-muted-foreground'}
          >
            <Terminal className="icon-base" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{t('terminal.toggle', 'Toggle Terminal')} (Ctrl+`)</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() =>
              startTransition(() => {
                const opening = !testRunnerOpen;
                setTestRunnerOpen(opening);
                updatePanelParam(opening ? 'tests' : null);
              })
            }
            data-testid="header-toggle-tests"
            className={testRunnerOpen ? 'text-foreground' : 'text-muted-foreground'}
          >
            <FlaskConical className="icon-base" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{t('tests.title', 'Tests')}</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() =>
              startTransition(() => {
                if (reviewPaneOpen && rightPaneTab === 'files') {
                  setFilesPaneOpen(false);
                  updatePanelParam(null);
                } else {
                  setFilesPaneOpen(true);
                  updatePanelParam('files');
                }
              })
            }
            data-testid="header-toggle-project-files"
            disabled={!projectId}
            className={
              reviewPaneOpen && rightPaneTab === 'files'
                ? 'text-foreground'
                : 'text-muted-foreground'
            }
          >
            <FolderTree className="icon-base" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{t('projectFiles.title', 'Project Files')}</TooltipContent>
      </Tooltip>
      <ReviewToggle
        showGitStats={!!showGitStats}
        effectiveGitStatus={effectiveGitStatus}
        hasPendingPush={hasPendingPush}
        hasPendingPull={hasPendingPull}
        unpushedCommitCount={unpushedCommitCount}
        unpulledCommitCount={unpulledCommitCount}
        reviewActive={reviewPaneOpen && rightPaneTab === 'review'}
        onToggle={toggleReview}
      />
      {activeThreadId && (
        <MoreActionsMenu
          onViewOnBoard={() => {
            setReviewPaneOpen(false);
            navigate(
              buildPath(`/kanban?project=${activeThreadProjectId}&highlight=${activeThreadId}`),
            );
          }}
        />
      )}
    </div>
  );
}

interface ReviewToggleProps {
  showGitStats: boolean;
  effectiveGitStatus:
    | { linesAdded: number; linesDeleted: number; dirtyFileCount: number }
    | undefined;
  hasPendingPush: boolean;
  hasPendingPull: boolean;
  unpushedCommitCount: number;
  unpulledCommitCount: number;
  reviewActive: boolean;
  onToggle: () => void;
}

function ReviewToggle({
  showGitStats,
  effectiveGitStatus,
  hasPendingPush,
  hasPendingPull,
  unpushedCommitCount,
  unpulledCommitCount,
  reviewActive,
  onToggle,
}: ReviewToggleProps) {
  const { t } = useTranslation();
  const tooltip = renderSyncTooltip(t, unpushedCommitCount, unpulledCommitCount);

  if (showGitStats && effectiveGitStatus) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={onToggle}
            data-testid="header-diff-stats"
            className="cursor-pointer"
          >
            <DiffStats
              linesAdded={effectiveGitStatus.linesAdded}
              linesDeleted={effectiveGitStatus.linesDeleted}
              dirtyFileCount={effectiveGitStatus.dirtyFileCount}
              size="sm"
              tooltips={false}
              className="font-semibold"
              trailing={
                <SyncArrows
                  hasPendingPush={hasPendingPush}
                  hasPendingPull={hasPendingPull}
                  withSeparator
                />
              }
            />
          </button>
        </TooltipTrigger>
        <TooltipContent>{tooltip}</TooltipContent>
      </Tooltip>
    );
  }
  if (hasPendingPush || hasPendingPull) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={onToggle}
            data-testid="header-sync-arrows"
            className="inline-flex flex-shrink-0 cursor-pointer items-center gap-1 rounded-lg border border-border px-2 py-0.5 font-mono text-sm font-semibold"
          >
            <SyncArrows hasPendingPush={hasPendingPush} hasPendingPull={hasPendingPull} />
          </button>
        </TooltipTrigger>
        <TooltipContent>{tooltip}</TooltipContent>
      </Tooltip>
    );
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onToggle}
          data-testid="header-toggle-review"
          className={cn(reviewActive ? 'text-foreground' : 'text-muted-foreground')}
        >
          <GitCompare className="icon-base" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  );
}

function SyncArrows({
  hasPendingPush,
  hasPendingPull,
  withSeparator = false,
}: {
  hasPendingPush: boolean;
  hasPendingPull: boolean;
  withSeparator?: boolean;
}) {
  if (!hasPendingPush && !hasPendingPull) return null;
  return (
    <>
      {withSeparator && <span className="text-muted-foreground">·</span>}
      <span
        className="inline-flex items-center text-foreground"
        data-testid="header-review-sync-arrows"
      >
        {hasPendingPush && <ArrowUp className="h-3 w-3" strokeWidth={2.5} />}
        {hasPendingPull && <ArrowDown className="h-3 w-3" strokeWidth={2.5} />}
      </span>
    </>
  );
}

function renderSyncTooltip(
  t: (key: string, opts?: Record<string, unknown>) => string,
  unpushedCommitCount: number,
  unpulledCommitCount: number,
): string {
  const parts: string[] = [];
  if (unpushedCommitCount > 0) {
    parts.push(
      t('review.readyToPush', {
        count: unpushedCommitCount,
        defaultValue: `${unpushedCommitCount} commit(s) ready to push`,
      }),
    );
  }
  if (unpulledCommitCount > 0) {
    parts.push(
      t('review.readyToPull', {
        count: unpulledCommitCount,
        defaultValue: `${unpulledCommitCount} commit(s) to pull`,
      }),
    );
  }
  return parts.length > 0 ? parts.join(' · ') : t('review.title');
}
