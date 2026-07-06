import { FlaskConical, FolderTree, GitCompare, Globe, MessageSquare, Terminal } from 'lucide-react';
import { memo, startTransition, useCallback, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation } from 'react-router-dom';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { ShortcutHint } from '@/components/ui/kbd';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { usePreviewWindow } from '@/hooks/use-preview-window';
import { useStableNavigate } from '@/hooks/use-stable-navigate';
import { api } from '@/lib/api';
import * as variant from '@/lib/thread-variant';
import { cn, resolveThreadBranch } from '@/lib/utils';
import { useAuthStore } from '@/stores/auth-store';
import { useProjectStore } from '@/stores/project-store';
import type { Editor } from '@/stores/settings-store';
import type { TerminalTab } from '@/stores/terminal-store';
import { useTerminalStore } from '@/stores/terminal-store';
import {
  useThreadId,
  useThreadProjectId,
  useThreadSelector,
  useThreadStatus,
  useThreadWorktreePath,
} from '@/stores/thread-context';
import { useUIStore } from '@/stores/ui-store';

import { ShareThreadButton } from './ShareThreadButton';
import { StartupCommandsPopover } from './StartupCommandsPopover';

export interface ThreadHeaderActionsProps {
  hideFiles?: boolean;
  hideTests?: boolean;
  hideStartup?: boolean;
  hideTerminal?: boolean;
  hideTimeline?: boolean;
  trailing?: ReactNode;
}

interface MoreActionsRenderArgs {
  isScratchThread: boolean;
  onOpenInEditor: (editor: Editor) => Promise<void>;
}

interface ThreadHeaderActionsBaseProps extends Omit<ThreadHeaderActionsProps, 'hideTimeline'> {
  renderMoreActions?: (args: MoreActionsRenderArgs) => ReactNode;
}

interface ActionButtonProps {
  active?: boolean;
  children: ReactNode;
  disabled?: boolean;
  label: ReactNode;
  onClick: () => void;
  testId: string;
}

function HeaderActionButton({
  active = false,
  children,
  disabled,
  label,
  onClick,
  testId,
}: ActionButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onClick}
          data-testid={testId}
          disabled={disabled}
          className={active ? 'text-foreground' : 'text-muted-foreground'}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function PreviewButton({
  command,
  openPreview,
}: {
  command: TerminalTab;
  openPreview: ReturnType<typeof usePreviewWindow>['openPreview'];
}) {
  const { t } = useTranslation();

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          data-testid="header-preview"
          variant="ghost"
          size="icon-sm"
          onClick={() => {
            openPreview({
              commandId: command.commandId!,
              projectId: command.projectId,
              port: command.port!,
              commandLabel: command.label,
            });
          }}
          className="text-status-info hover:text-status-info/80"
        >
          <Globe className="icon-base" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{t('preview.openPreview')}</TooltipContent>
    </Tooltip>
  );
}

function TerminalToggleButton({
  activeThreadWorktreePath,
  isTauri,
  project,
  projectId,
  tabs,
  terminalPanelVisible,
}: {
  activeThreadWorktreePath?: string;
  isTauri: boolean;
  project?: { path: string };
  projectId?: string;
  tabs: TerminalTab[];
  terminalPanelVisible: boolean;
}) {
  const { t } = useTranslation();
  const addTab = useTerminalStore((s) => s.addTab);
  const setPanelVisible = useTerminalStore((s) => s.setPanelVisible);
  const toggleTerminalPanel = useTerminalStore((s) => s.togglePanel);

  return (
    <HeaderActionButton
      active={terminalPanelVisible}
      testId="header-toggle-terminal"
      onClick={() => {
        if (!projectId) return;
        const projectTabs = tabs.filter((t) => t.projectId === projectId);

        if (projectTabs.length === 0 && !terminalPanelVisible) {
          addTab({
            id: crypto.randomUUID(),
            label: 'Terminal 1',
            cwd: activeThreadWorktreePath || project?.path || 'C:\\',
            alive: true,
            projectId,
            type: isTauri ? undefined : 'pty',
          });
          setPanelVisible(projectId, true);
        } else {
          toggleTerminalPanel(projectId);
        }
      }}
      label={<ShortcutHint label={t('terminal.toggle', 'Toggle Terminal')} keys={['Ctrl', '`']} />}
    >
      <Terminal className="icon-base" />
    </HeaderActionButton>
  );
}

function CommentsToggleButton({
  active,
  commentCount,
  onClick,
}: {
  active: boolean;
  commentCount: number;
  onClick: () => void;
}) {
  const { t } = useTranslation();

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onClick}
          data-testid="header-toggle-comments"
          className={cn(
            'relative',
            active
              ? 'text-foreground'
              : commentCount > 0
                ? 'text-status-info'
                : 'text-muted-foreground',
          )}
        >
          <MessageSquare className="icon-base" />
          {commentCount > 0 && (
            <span
              className="bg-status-info absolute -top-0.5 -right-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full px-0.5 text-[9px] leading-none font-medium text-white"
              data-testid="comments-badge"
            >
              {commentCount > 99 ? '99+' : commentCount}
            </span>
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        <ShortcutHint label={t('comments.title', 'Comments')} keys={['Alt', 'M']} />
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * The right-side cluster of thread action icons. Store reads stay here so the
 * same component can be mounted under any thread context.
 */
export const ThreadHeaderActionsBase = memo(function ThreadHeaderActionsBase({
  hideFiles = false,
  hideTests = false,
  hideStartup = false,
  hideTerminal = false,
  renderMoreActions,
  trailing,
}: ThreadHeaderActionsBaseProps = {}) {
  const { t } = useTranslation();
  const navigate = useStableNavigate();
  const location = useLocation();
  const activeThreadId = useThreadId();
  const activeThreadProjectId = useThreadProjectId();
  const activeThreadStatus = useThreadStatus();
  const activeThreadWorktreePath = useThreadWorktreePath();
  const activeThreadBranch = useThreadSelector((thread) =>
    thread ? resolveThreadBranch(thread) : undefined,
  );
  const selfUserId = useAuthStore((s) => s.user?.id ?? null);
  const activeThreadCanShowGit = useThreadSelector(
    (thread) =>
      variant.canDoGitOps(thread) &&
      !(
        !!selfUserId &&
        variant.isReadOnlyShare(thread, selfUserId) &&
        !variant.canViewGitShare(thread, selfUserId)
      ),
  );
  const activeThreadIsScratch = useThreadSelector((thread) => variant.isScratch(thread));
  const selectedProjectId = useProjectStore((s) => s.selectedProjectId);
  const projects = useProjectStore((s) => s.projects);
  const setReviewPaneOpen = useUIStore((s) => s.setReviewPaneOpen);
  const reviewPaneOpen = useUIStore((s) => s.reviewPaneOpen);
  const setTestRunnerOpen = useUIStore((s) => s.setTestRunnerOpen);
  const testRunnerOpen = useUIStore((s) => s.testRunnerOpen);
  const setFilesPaneOpen = useUIStore((s) => s.setFilesPaneOpen);
  const setCommentsPaneOpen = useUIStore((s) => s.setCommentsPaneOpen);
  const rightPaneTab = useUIStore((s) => s.rightPaneTab);
  const canShowComments = useThreadSelector((thread) => variant.canShowComments(thread));
  const commentCount = useThreadSelector((thread) => thread?.commentCount ?? 0);
  const { openPreview, isTauri } = usePreviewWindow();
  const panelVisibleByProject = useTerminalStore((s) => s.panelVisibleByProject);
  const tabs = useTerminalStore((s) => s.tabs);

  const projectId = activeThreadProjectId ?? selectedProjectId;
  const project = projects.find((p) => p.id === projectId);
  const terminalPanelVisible = projectId ? (panelVisibleByProject[projectId] ?? false) : false;
  const runningWithPort = tabs.filter(
    (tab) => tab.projectId === projectId && tab.commandId && tab.alive && tab.port,
  );
  const firstRunningWithPort = runningWithPort[0];

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

  const handleOpenInEditor = async (editor: Editor) => {
    if (!project) return;
    const folderPath = activeThreadWorktreePath || project.path;
    const result = await api.openInEditor(folderPath, editor);
    if (result.isErr()) {
      toast.error(t('sidebar.openInEditorError', 'Failed to open in editor'));
    }
  };

  if (activeThreadStatus === 'setting_up') return null;

  const reviewPanelActive = reviewPaneOpen && rightPaneTab === 'review';
  const filesPanelActive = reviewPaneOpen && rightPaneTab === 'files';
  const commentsPanelActive = reviewPaneOpen && rightPaneTab === 'comments';

  return (
    <div className="flex shrink-0 items-center gap-2">
      {!hideStartup && !activeThreadIsScratch && projectId && (
        <StartupCommandsPopover
          projectId={projectId}
          threadId={activeThreadId ?? undefined}
          worktreeBranch={activeThreadBranch ?? undefined}
        />
      )}
      {!activeThreadIsScratch && firstRunningWithPort && (
        <PreviewButton command={firstRunningWithPort} openPreview={openPreview} />
      )}
      {!hideTerminal && !activeThreadIsScratch && (
        <TerminalToggleButton
          activeThreadWorktreePath={activeThreadWorktreePath ?? undefined}
          isTauri={isTauri}
          project={project}
          projectId={projectId ?? undefined}
          tabs={tabs}
          terminalPanelVisible={terminalPanelVisible}
        />
      )}
      {(activeThreadCanShowGit ||
        (!activeThreadId && selectedProjectId && !activeThreadIsScratch)) && (
        <HeaderActionButton
          active={reviewPanelActive}
          testId="header-toggle-review"
          onClick={() =>
            startTransition(() => {
              setReviewPaneOpen(!reviewPanelActive);
              updatePanelParam(reviewPanelActive ? null : 'review');
            })
          }
          label={<ShortcutHint label={t('review.title')} keys={['Alt', 'G']} />}
        >
          <GitCompare className="icon-base" />
        </HeaderActionButton>
      )}
      {!hideTests && !activeThreadIsScratch && (
        <HeaderActionButton
          active={testRunnerOpen}
          testId="header-toggle-tests"
          onClick={() =>
            startTransition(() => {
              const opening = !testRunnerOpen;
              setTestRunnerOpen(opening);
              updatePanelParam(opening ? 'tests' : null);
            })
          }
          label={t('tests.title', 'Tests')}
        >
          <FlaskConical className="icon-base" />
        </HeaderActionButton>
      )}
      {!hideFiles && !activeThreadIsScratch && (
        <HeaderActionButton
          active={filesPanelActive}
          testId="header-toggle-project-files"
          disabled={!projectId}
          onClick={() =>
            startTransition(() => {
              setFilesPaneOpen(!filesPanelActive);
              updatePanelParam(filesPanelActive ? null : 'files');
            })
          }
          label={
            <ShortcutHint label={t('projectFiles.title', 'Project Files')} keys={['Alt', 'F']} />
          }
        >
          <FolderTree className="icon-base" />
        </HeaderActionButton>
      )}
      {activeThreadId && canShowComments && (
        <CommentsToggleButton
          active={commentsPanelActive}
          commentCount={commentCount}
          onClick={() =>
            startTransition(() => {
              setCommentsPaneOpen(!commentsPanelActive);
              updatePanelParam(commentsPanelActive ? null : 'comments');
            })
          }
        />
      )}
      {activeThreadId && projectId && !activeThreadIsScratch && (
        <ShareThreadButton threadId={activeThreadId} projectId={projectId} />
      )}
      {activeThreadId &&
        renderMoreActions?.({
          isScratchThread: activeThreadIsScratch,
          onOpenInEditor: handleOpenInEditor,
        })}
      {trailing}
    </div>
  );
});
