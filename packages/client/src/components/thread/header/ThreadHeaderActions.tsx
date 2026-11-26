import { FlaskConical, FolderTree, GitCompare, Globe, Terminal } from 'lucide-react';
import { memo, startTransition, useCallback, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation } from 'react-router-dom';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { ShortcutHint } from '@/components/ui/kbd';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useProjects } from '@/data/projects/hooks';
import { usePreviewWindow } from '@/hooks/use-preview-window';
import { useStableNavigate } from '@/hooks/use-stable-navigate';
import { api } from '@/lib/api';
import * as variant from '@/lib/thread-variant';
import { resolveThreadBranch } from '@/lib/utils';
import { useAuthStore } from '@/stores/auth-store';
import { useBrowserPanelStore } from '@/stores/browser-panel-store';
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
import { selectRightPanel, useUIStore } from '@/stores/ui-store';

import { ShareThreadDialog } from './ShareThreadDialog';
import { StartupCommandsPopover } from './StartupCommandsPopover';

export interface ThreadHeaderActionsProps {
  hideFiles?: boolean;
  hideTests?: boolean;
  hideStartup?: boolean;
  hideTerminal?: boolean;
  hideTimeline?: boolean;
  trailing?: ReactNode;
}

/** The comments pane toggle, shown as an item of the "More actions" menu. */
export interface CommentsMenuAction {
  active: boolean;
  count: number;
  onToggle: () => void;
}

interface MoreActionsRenderArgs {
  isScratchThread: boolean;
  onOpenInEditor: (editor: Editor) => Promise<void>;
  /** Absent when the thread cannot show comments. */
  comments?: CommentsMenuAction;
  /** Whether the user can share the thread: they own it and it is a project thread. */
  canShare: boolean;
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
          variant={active ? 'active' : 'muted'}
          size="icon-sm"
          onClick={onClick}
          data-testid={testId}
          disabled={disabled}
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
          variant="ghost-info"
          size="icon-sm"
          onClick={() => {
            openPreview({
              commandId: command.commandId!,
              projectId: command.projectId,
              port: command.port!,
              commandLabel: command.label,
            });
          }}
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

/** Opens/closes the browser panel (the thread's shared browser session). */
function BrowserToggleButton({
  threadId,
  projectId,
}: {
  threadId?: string | null;
  projectId?: string | null;
}) {
  const { t } = useTranslation();
  const open = useBrowserPanelStore((s) => s.open);
  const togglePanel = useBrowserPanelStore((s) => s.togglePanel);
  if (!threadId && !projectId) return null;
  return (
    <HeaderActionButton
      active={open}
      testId="header-toggle-browser"
      onClick={togglePanel}
      label={t('preview.browser')}
    >
      <Globe className="icon-base" />
    </HeaderActionButton>
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
  const isThreadOwner = useThreadSelector(
    (thread) => !!selfUserId && thread?.userId === selfUserId,
  );
  const selectedProjectId = useProjectStore((s) => s.selectedProjectId);
  const projects = useProjects();
  const togglePanel = useUIStore((s) => s.togglePanel);
  const rightPanel = useUIStore(selectRightPanel);
  const setTestRunnerOpen = useUIStore((s) => s.setTestRunnerOpen);
  const testRunnerOpen = useUIStore((s) => s.testRunnerOpen);
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

  const reviewPanelActive = rightPanel === 'review';
  const filesPanelActive = rightPanel === 'files';
  const commentsPanelActive = rightPanel === 'comments';
  // Sharing is owner-only and not for scratch threads.
  const canShare = !!activeThreadId && !!projectId && !activeThreadIsScratch && isThreadOwner;

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
              togglePanel('review');
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
              togglePanel('files');
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
      <BrowserToggleButton threadId={activeThreadId} projectId={projectId} />
      {canShare && activeThreadId && projectId && (
        <ShareThreadDialog threadId={activeThreadId} projectId={projectId} />
      )}
      {activeThreadId &&
        renderMoreActions?.({
          isScratchThread: activeThreadIsScratch,
          onOpenInEditor: handleOpenInEditor,
          comments: canShowComments
            ? {
                active: commentsPanelActive,
                count: commentCount,
                onToggle: () =>
                  startTransition(() => {
                    togglePanel('comments');
                    updatePanelParam(commentsPanelActive ? null : 'comments');
                  }),
              }
            : undefined,
          canShare,
        })}
      {trailing}
    </div>
  );
});
