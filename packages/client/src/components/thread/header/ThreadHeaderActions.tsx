import { Globe } from 'lucide-react';
import { memo, startTransition, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useProjects } from '@/data/projects/hooks';
import { usePanelParam } from '@/hooks/use-panel-param';
import { usePreviewWindow } from '@/hooks/use-preview-window';
import { api } from '@/lib/api';
import * as variant from '@/lib/thread-variant';
import { resolveThreadBranch } from '@/lib/utils';
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
import { selectRightPanel, useUIStore } from '@/stores/ui-store';

import { ShareThreadDialog } from './ShareThreadDialog';
import { StartupCommandsPopover } from './StartupCommandsPopover';

export interface ThreadHeaderActionsProps {
  hideStartup?: boolean;
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

/**
 * The right-side cluster of thread action icons. Store reads stay here so the
 * same component can be mounted under any thread context.
 */
export const ThreadHeaderActionsBase = memo(function ThreadHeaderActionsBase({
  hideStartup = false,
  renderMoreActions,
  trailing,
}: ThreadHeaderActionsBaseProps = {}) {
  const { t } = useTranslation();
  const setPanelParam = usePanelParam();
  const activeThreadId = useThreadId();
  const activeThreadProjectId = useThreadProjectId();
  const activeThreadStatus = useThreadStatus();
  const activeThreadWorktreePath = useThreadWorktreePath();
  const activeThreadBranch = useThreadSelector((thread) =>
    thread ? resolveThreadBranch(thread) : undefined,
  );
  const selfUserId = useAuthStore((s) => s.user?.id ?? null);
  const activeThreadIsScratch = useThreadSelector((thread) => variant.isScratch(thread));
  const isThreadOwner = useThreadSelector(
    (thread) => !!selfUserId && thread?.userId === selfUserId,
  );
  const selectedProjectId = useProjectStore((s) => s.selectedProjectId);
  const projects = useProjects();
  const togglePanel = useUIStore((s) => s.togglePanel);
  const rightPanel = useUIStore(selectRightPanel);
  const canShowComments = useThreadSelector((thread) => variant.canShowComments(thread));
  const commentCount = useThreadSelector((thread) => thread?.commentCount ?? 0);
  const { openPreview } = usePreviewWindow();
  const tabs = useTerminalStore((s) => s.tabs);

  const projectId = activeThreadProjectId ?? selectedProjectId;
  const project = projects.find((p) => p.id === projectId);
  const runningWithPort = tabs.filter(
    (tab) => tab.projectId === projectId && tab.commandId && tab.alive && tab.port,
  );
  const firstRunningWithPort = runningWithPort[0];

  const handleOpenInEditor = async (editor: Editor) => {
    if (!project) return;
    const folderPath = activeThreadWorktreePath || project.path;
    const result = await api.openInEditor(folderPath, editor);
    if (result.isErr()) {
      toast.error(t('sidebar.openInEditorError', 'Failed to open in editor'));
    }
  };

  if (activeThreadStatus === 'setting_up') return null;

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
                    setPanelParam(commentsPanelActive ? null : 'comments');
                  }),
              }
            : undefined,
          canShare,
        })}
      {trailing}
    </div>
  );
});
