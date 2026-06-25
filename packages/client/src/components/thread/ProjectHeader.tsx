import type { Message, ToolCall, ThreadStage } from '@funny/shared';
import {
  AppWindow,
  GitCompare,
  GitFork,
  GitBranch,
  Globe,
  Terminal,
  ExternalLink,
  Pin,
  PinOff,
  Loader2,
  Columns3,
  ArrowLeft,
  Milestone,
  Copy,
  ClipboardList,
  Check,
  EllipsisVertical,
  Trash2,
  FolderTree,
  FlaskConical,
  Activity,
  Sparkles,
  MessageSquare,
} from 'lucide-react';
import {
  memo,
  useState,
  useEffect,
  useCallback,
  useRef,
  startTransition,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation } from 'react-router-dom';
import { toast } from 'sonner';

import { ConfirmDialog } from '@/components/ConfirmDialog';
import { ThreadTitle } from '@/components/thread/ThreadAttachmentsBadge';
import {
  Breadcrumb,
  BreadcrumbList,
  BreadcrumbItem,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { ShortcutHint } from '@/components/ui/kbd';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useCopyToClipboard } from '@/hooks/use-copy-to-clipboard';
import { usePreviewWindow } from '@/hooks/use-preview-window';
import { useStableNavigate } from '@/hooks/use-stable-navigate';
import { api } from '@/lib/api';
import { stageConfig } from '@/lib/thread-utils';
import * as variant from '@/lib/thread-variant';
import { buildPath } from '@/lib/url';
import { cn, resolveThreadBranch } from '@/lib/utils';
import { useAgentTemplateStore } from '@/stores/agent-template-store';
import { useAuthStore } from '@/stores/auth-store';
import { useBrowserPanelStore } from '@/stores/browser-panel-store';
import { useGitStatusStore } from '@/stores/git-status-store';
import { useProjectStore } from '@/stores/project-store';
import { editorLabels, type Editor } from '@/stores/settings-store';
import { useTerminalStore } from '@/stores/terminal-store';
import {
  getThreadById,
  useThreadId,
  useThreadProjectId,
  useThreadSelector,
  useThreadStatus,
  useThreadWorktreePath,
} from '@/stores/thread-context';
import { useThreadStore } from '@/stores/thread-store';
import { useUIStore } from '@/stores/ui-store';

import { ShareThreadButton } from './header/ShareThreadButton';
import { StartupCommandsPopover } from './header/StartupCommandsPopover';

type MessageWithToolCalls = Message & { toolCalls?: ToolCall[] };

function threadToMarkdown(messages: MessageWithToolCalls[], includeToolCalls: boolean): string {
  const lines: string[] = [];
  for (const msg of messages) {
    const role = msg.role === 'user' ? 'User' : msg.role === 'assistant' ? 'Assistant' : 'System';
    if (msg.content?.trim()) {
      lines.push(`## ${role}\n\n${msg.content.trim()}\n`);
    }
    if (includeToolCalls && msg.toolCalls?.length) {
      for (const tc of msg.toolCalls) {
        let inputStr = '';
        try {
          const parsed = typeof tc.input === 'string' ? JSON.parse(tc.input) : tc.input;
          inputStr = JSON.stringify(parsed, null, 2);
        } catch {
          inputStr = String(tc.input);
        }
        lines.push(`### Tool: ${tc.name}\n\n\`\`\`json\n${inputStr}\n\`\`\`\n`);
        if (tc.output) {
          lines.push(`**Output:**\n\n\`\`\`\n${tc.output}\n\`\`\`\n`);
        }
      }
    }
  }
  return lines.join('\n');
}

interface MoreActionsMenuProps {
  onOpenInEditor?: (editor: Editor) => void;
  editorLabels?: Record<Editor, string>;
  hideTimeline?: boolean;
}

const MoreActionsMenu = memo(function MoreActionsMenu({
  onOpenInEditor,
  editorLabels: editorLabelsProp,
  hideTimeline = false,
}: MoreActionsMenuProps = {}) {
  const { t } = useTranslation();
  const navigate = useStableNavigate();
  const threadId = useThreadId();
  const threadProjectId = useThreadProjectId();
  const threadTitle = useThreadSelector((t) => t?.title);
  const threadMode = useThreadSelector((t) => t?.mode);
  const threadBranch = useThreadSelector((t) => (t ? resolveThreadBranch(t) : undefined));
  const threadPinned = useThreadSelector((t) => t?.pinned);
  const threadStage = useThreadSelector((t) => t?.stage);
  const isScratchThread = useThreadSelector((t) => variant.isScratch(t));
  const hasMessages = useThreadSelector((t) => (t?.messages?.length ?? 0) > 0);
  const pinThread = useThreadStore((s) => s.pinThread);
  const updateThreadStage = useThreadStore((s) => s.updateThreadStage);
  const deleteScratchThread = useThreadStore((s) => s.deleteScratchThread);
  const timelineVisible = useUIStore((s) => s.timelineVisible);
  const setTimelineVisible = useUIStore((s) => s.setTimelineVisible);
  const reviewPaneOpen = useUIStore((s) => s.reviewPaneOpen);
  const setReviewPaneOpen = useUIStore((s) => s.setReviewPaneOpen);
  const rightPaneTab = useUIStore((s) => s.rightPaneTab);
  const setActivityPaneOpen = useUIStore((s) => s.setActivityPaneOpen);
  const activityActive = reviewPaneOpen && rightPaneTab === 'activity';
  const menuSelectedProjectId = useProjectStore((s) => s.selectedProjectId);
  const browserPanelOpen = useBrowserPanelStore((s) => s.open);
  const toggleBrowserPanel = useBrowserPanelStore((s) => s.togglePanel);
  const canShowBrowserPanel = !!menuSelectedProjectId && !isScratchThread;
  const showStage = !!threadId && !!threadStage && threadStage !== 'archived' && !isScratchThread;
  const [copiedText, copyText] = useCopyToClipboard();
  const [copiedTools, copyTools] = useCopyToClipboard();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const isWorktree = threadMode === 'worktree' && !!threadBranch;
  const threadStatus = useThreadStatus();
  const isBusy = threadStatus === 'running' || threadStatus === 'setting_up';
  // Scratch threads have no git working tree, so no worktree/branch conversion.
  const canConvert = useThreadSelector((t) => variant.canConvertToWorktree(t)) && !isBusy;

  // Tooltip ↔ DropdownMenu: suppress tooltip while dropdown is open and
  // briefly after it closes (focus-return would otherwise flash the tooltip).
  const [moreActionsTooltipBlocked, setMoreActionsTooltipBlocked] = useState(false);
  const [moreActionsTooltipOpen, setMoreActionsTooltipOpen] = useState(false);
  const handleMoreActionsDropdown = useCallback((open: boolean) => {
    if (open) {
      setMoreActionsTooltipBlocked(true);
    } else {
      // Keep blocked briefly so the focus-return tooltip doesn't flash
      (document.activeElement as HTMLElement)?.blur();
      setTimeout(() => setMoreActionsTooltipBlocked(false), 150);
    }
  }, []);

  // Create Branch dialog state
  const [createBranchOpen, setCreateBranchOpen] = useState(false);
  const [branchName, setBranchName] = useState('');
  const [createBranchLoading, setCreateBranchLoading] = useState(false);

  const handleSuggestBranchName = useCallback(() => {
    const title = threadTitle;
    if (!title) return;
    const slug = title
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .slice(0, 60);
    if (slug) setBranchName(slug);
  }, [threadTitle]);

  const handleConvertToWorktree = useCallback(async () => {
    if (!threadId) return;
    const result = await api.convertToWorktree(threadId);
    if (result.isErr()) {
      toast.error(String(result.error));
    } else {
      toast.success(t('toast.convertToWorktreeStarted'));
    }
  }, [threadId, t]);

  const handleCreateBranch = useCallback(async () => {
    const name = branchName
      .trim()
      .replace(/\s+/g, '-')
      .replace(/[^a-zA-Z0-9\-_/.]/g, '');
    if (!name || !threadProjectId) return;
    setCreateBranchLoading(true);
    const result = await api.checkout(threadProjectId, name, 'carry', true, threadId);
    setCreateBranchLoading(false);
    if (result.isErr()) {
      toast.error(String(result.error));
    } else {
      setCreateBranchOpen(false);
      setBranchName('');
    }
  }, [branchName, threadProjectId, threadId]);

  const handleDeleteConfirm = useCallback(async () => {
    if (!threadId) return;
    const thread = getThreadById(threadId);
    if (!thread) return;
    const title = thread.title;
    setDeleteLoading(true);
    if (variant.isScratch(thread)) {
      await deleteScratchThread(threadId);
      setDeleteLoading(false);
      setDeleteOpen(false);
      toast.success(t('toast.threadDeleted', { title }));
      navigate(buildPath('/'));
      return;
    }
    const projId = thread.projectId;
    if (!projId) {
      setDeleteLoading(false);
      return;
    }
    await useThreadStore.getState().deleteThread(threadId, projId);
    setDeleteLoading(false);
    setDeleteOpen(false);
    toast.success(t('toast.threadDeleted', { title }));
    navigate(buildPath(`/projects/${projId}`));
  }, [navigate, t, threadId, deleteScratchThread]);

  const handleCopy = useCallback(
    (includeToolCalls: boolean) => {
      if (!threadId) return;
      const messages = getThreadById(threadId)?.messages;
      if (!messages?.length) return;
      const md = threadToMarkdown(messages, includeToolCalls);
      if (includeToolCalls) {
        copyTools(md);
      } else {
        copyText(md);
      }
    },
    [copyText, copyTools, threadId],
  );

  return (
    <>
      <DropdownMenu onOpenChange={handleMoreActionsDropdown}>
        <Tooltip
          open={!moreActionsTooltipBlocked && moreActionsTooltipOpen}
          onOpenChange={setMoreActionsTooltipOpen}
        >
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button
                data-testid="header-more-actions"
                variant="ghost"
                size="icon-sm"
                className="text-muted-foreground"
              >
                <EllipsisVertical className="icon-base" />
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent>{t('thread.moreActions', 'More actions')}</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end">
          {(showStage || (threadId && !isScratchThread)) && (
            <>
              {showStage && (
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger data-testid="header-menu-stage">
                    {(() => {
                      const StageIcon = stageConfig[threadStage!].icon;
                      return <StageIcon className="icon-base mr-2" />;
                    })()}
                    {t('kanban.stage', 'Stage')}
                    <span className="text-muted-foreground ml-auto pl-2 text-xs">
                      {t(stageConfig[threadStage!].labelKey)}
                    </span>
                  </DropdownMenuSubTrigger>
                  <DropdownMenuPortal>
                    <DropdownMenuSubContent>
                      {VISIBLE_STAGES.map((s) => {
                        const Icon = stageConfig[s].icon;
                        return (
                          <DropdownMenuItem
                            key={s}
                            data-testid={`header-menu-stage-${s}`}
                            onClick={() => updateThreadStage(threadId!, threadProjectId!, s)}
                            className="cursor-pointer"
                          >
                            <Icon className="icon-base mr-2" />
                            {t(stageConfig[s].labelKey)}
                            {s === threadStage && <Check className="icon-base ml-auto pl-1" />}
                          </DropdownMenuItem>
                        );
                      })}
                    </DropdownMenuSubContent>
                  </DropdownMenuPortal>
                </DropdownMenuSub>
              )}
              {threadId && !isScratchThread && (
                <DropdownMenuItem
                  data-testid="header-menu-view-board"
                  onClick={() => {
                    setReviewPaneOpen(false);
                    navigate(buildPath(`/kanban?project=${threadProjectId}&highlight=${threadId}`));
                  }}
                  className="cursor-pointer"
                >
                  <Columns3 className="icon-base mr-2" />
                  {t('kanban.viewOnBoard', 'View on Board')}
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
            </>
          )}
          <DropdownMenuItem
            data-testid="header-menu-toggle-activity"
            onClick={() =>
              startTransition(() => {
                setActivityPaneOpen(!activityActive);
              })
            }
            className="cursor-pointer"
          >
            <Activity className={`icon-base mr-2 ${activityActive ? 'text-primary' : ''}`} />
            {t('activity.title', 'Activity')}
          </DropdownMenuItem>
          {threadId && !hideTimeline && (
            <DropdownMenuItem
              data-testid="header-menu-toggle-timeline"
              onClick={() => setTimelineVisible(!timelineVisible)}
              className="cursor-pointer"
            >
              <Milestone className={`icon-base mr-2 ${timelineVisible ? 'text-primary' : ''}`} />
              {t('thread.toggleTimeline', 'Toggle Timeline')}
            </DropdownMenuItem>
          )}
          {canShowBrowserPanel && (
            <DropdownMenuItem
              data-testid="header-menu-browser-panel"
              onClick={() => toggleBrowserPanel()}
              className="cursor-pointer"
            >
              <AppWindow className={`icon-base mr-2 ${browserPanelOpen ? 'text-primary' : ''}`} />
              {t('projectHeader.browserPanel', 'Browser annotator')}
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            data-testid="header-menu-copy-text"
            onClick={() => handleCopy(false)}
            disabled={!hasMessages}
            className="cursor-pointer"
          >
            {copiedText ? (
              <Check className="icon-base mr-2" />
            ) : (
              <Copy className="icon-base mr-2" />
            )}
            {t('thread.copyText', 'Copy text only')}
          </DropdownMenuItem>
          <DropdownMenuItem
            data-testid="header-menu-copy-all"
            onClick={() => handleCopy(true)}
            disabled={!hasMessages}
            className="cursor-pointer"
          >
            {copiedTools ? (
              <Check className="icon-base mr-2" />
            ) : (
              <ClipboardList className="icon-base mr-2" />
            )}
            {t('thread.copyWithTools', 'Copy with tool calls')}
          </DropdownMenuItem>
          {onOpenInEditor && editorLabelsProp && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuSub>
                <DropdownMenuSubTrigger data-testid="header-menu-open-editor">
                  <ExternalLink className="icon-base mr-2" />
                  {t('thread.openInEditor', 'Open in Editor')}
                </DropdownMenuSubTrigger>
                <DropdownMenuPortal>
                  <DropdownMenuSubContent>
                    {(Object.keys(editorLabelsProp) as Editor[]).map((editor) => (
                      <DropdownMenuItem
                        key={editor}
                        data-testid={`header-menu-open-editor-${editor}`}
                        onClick={() => onOpenInEditor(editor)}
                        className="cursor-pointer"
                      >
                        {editorLabelsProp[editor]}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuSubContent>
                </DropdownMenuPortal>
              </DropdownMenuSub>
            </>
          )}
          {threadId && canConvert && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                data-testid="header-menu-convert-worktree"
                onClick={handleConvertToWorktree}
                className="cursor-pointer"
              >
                <GitFork className="icon-base mr-2" />
                {t('dialog.convertToWorktreeTitle')}
              </DropdownMenuItem>
              <DropdownMenuItem
                data-testid="header-menu-create-branch"
                onClick={() => setCreateBranchOpen(true)}
                className="cursor-pointer"
              >
                <GitBranch className="icon-base mr-2" />
                {t('dialog.createBranchTitle')}
              </DropdownMenuItem>
            </>
          )}
          {threadId && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                data-testid="header-menu-pin"
                onClick={() => {
                  const next = !threadPinned;
                  pinThread(threadId, threadProjectId!, next);
                  toast.success(
                    next
                      ? t('toast.threadPinned', 'Thread pinned')
                      : t('toast.threadUnpinned', 'Thread unpinned'),
                  );
                }}
                className="cursor-pointer"
              >
                {threadPinned ? (
                  <>
                    <PinOff className="icon-base mr-2" />
                    {t('sidebar.unpin', 'Unpin')}
                  </>
                ) : (
                  <>
                    <Pin className="icon-base mr-2" />
                    {t('sidebar.pin', 'Pin')}
                  </>
                )}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                data-testid="header-menu-delete"
                onClick={() => setDeleteOpen(true)}
                className="text-status-error focus:text-status-error cursor-pointer"
              >
                <Trash2 className="icon-base mr-2" />
                {t('common.delete', 'Delete')}
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={(open) => {
          if (!open) setDeleteOpen(false);
        }}
        title={t('dialog.deleteThread')}
        description={t('dialog.deleteThreadDesc', {
          title:
            threadTitle && threadTitle.length > 80 ? threadTitle.slice(0, 80) + '…' : threadTitle,
        })}
        warning={isWorktree ? t('dialog.worktreeWarning') : undefined}
        cancelLabel={t('common.cancel')}
        confirmLabel={t('common.delete')}
        loading={deleteLoading}
        onCancel={() => setDeleteOpen(false)}
        onConfirm={handleDeleteConfirm}
      />
      <Dialog open={createBranchOpen} onOpenChange={setCreateBranchOpen}>
        <DialogContent className="sm:max-w-md" data-testid="create-branch-dialog">
          <DialogHeader>
            <DialogTitle>{t('dialog.createBranchTitle')}</DialogTitle>
          </DialogHeader>
          <div className="flex items-center gap-2">
            <Input
              data-testid="create-branch-input"
              placeholder={t('dialog.createBranchPlaceholder')}
              value={branchName}
              onChange={(e) => setBranchName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && branchName.trim()) handleCreateBranch();
              }}
              autoFocus
            />
            {threadTitle && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    data-testid="create-branch-suggest"
                    variant="ghost"
                    size="icon-sm"
                    onClick={handleSuggestBranchName}
                  >
                    <Sparkles className="icon-base" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  {t('dialog.suggestBranchName', 'Suggest from title')}
                </TooltipContent>
              </Tooltip>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setCreateBranchOpen(false)}
              data-testid="create-branch-cancel"
            >
              {t('common.cancel')}
            </Button>
            <Button
              onClick={handleCreateBranch}
              disabled={!branchName.trim() || createBranchLoading}
              data-testid="create-branch-confirm"
            >
              {createBranchLoading ? (
                <Loader2 className="icon-base animate-spin" />
              ) : (
                t('common.create', 'Create')
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
});

const VISIBLE_STAGES: ThreadStage[] = [
  'backlog',
  'planning',
  'in_progress',
  'review',
  'done',
  'archived',
];

interface ThreadHeaderActionsProps {
  hideFiles?: boolean;
  hideTests?: boolean;
  hideStartup?: boolean;
  hideTerminal?: boolean;
  hideTimeline?: boolean;
  trailing?: ReactNode;
}

/**
 * The right-side cluster of thread action icons (startup / preview / terminal /
 * review / tests / files / comments / share / more-actions). Extracted from
 * `ProjectHeader` so it can be mounted standalone in the grid view header
 * (`LiveColumnsView`) bound to the grid-selected thread via `ThreadProvider`.
 *
 * Everything it needs is read from the thread context + stores, so binding it
 * to a different thread is purely a matter of wrapping it in the right
 * `ThreadProvider`. It self-gates to nothing while the thread is setting up.
 */
export const ThreadHeaderActions = memo(function ThreadHeaderActions({
  hideFiles = false,
  hideTests = false,
  hideStartup = false,
  hideTerminal = false,
  hideTimeline = false,
  trailing,
}: ThreadHeaderActionsProps = {}) {
  const { t } = useTranslation();
  const navigate = useStableNavigate();
  const location = useLocation();
  const activeThreadId = useThreadId();
  const activeThreadProjectId = useThreadProjectId();
  const activeThreadStatus = useThreadStatus();
  const activeThreadWorktreePath = useThreadWorktreePath();
  const activeThreadBranch = useThreadSelector((t) => (t ? resolveThreadBranch(t) : undefined));
  // Git/review affordances require git ops AND must hide from a `view` sharee
  // (thread-sharing-steer) — their git API 404s. Fail OPEN: only hide when we
  // POSITIVELY know the viewer is a non-owner sharee without a steer grant.
  const selfUserId = useAuthStore((s) => s.user?.id ?? null);
  const activeThreadCanShowGit = useThreadSelector(
    (t) =>
      variant.canDoGitOps(t) &&
      !(
        !!selfUserId &&
        variant.isReadOnlyShare(t, selfUserId) &&
        !variant.canViewGitShare(t, selfUserId)
      ),
  );
  const activeThreadIsScratch = useThreadSelector((t) => variant.isScratch(t));
  const selectedProjectId = useProjectStore((s) => s.selectedProjectId);
  const projects = useProjectStore((s) => s.projects);
  const setReviewPaneOpen = useUIStore((s) => s.setReviewPaneOpen);
  const reviewPaneOpen = useUIStore((s) => s.reviewPaneOpen);
  const setTestRunnerOpen = useUIStore((s) => s.setTestRunnerOpen);
  const testRunnerOpen = useUIStore((s) => s.testRunnerOpen);
  const setFilesPaneOpen = useUIStore((s) => s.setFilesPaneOpen);
  const setCommentsPaneOpen = useUIStore((s) => s.setCommentsPaneOpen);
  const rightPaneTab = useUIStore((s) => s.rightPaneTab);
  const canShowComments = useThreadSelector((t) => variant.canShowComments(t));
  const commentCount = useThreadSelector((t) => t?.commentCount ?? 0);
  const { openPreview, isTauri } = usePreviewWindow();
  const toggleTerminalPanel = useTerminalStore((s) => s.togglePanel);
  const panelVisibleByProject = useTerminalStore((s) => s.panelVisibleByProject);
  const setPanelVisible = useTerminalStore((s) => s.setPanelVisible);
  const addTab = useTerminalStore((s) => s.addTab);

  // Prefer the context thread's project (grid-aware) over the globally selected
  // one, so startup / terminal / preview in the grid header target the selected
  // thread's project. In the main view the two are equivalent.
  const projectId = activeThreadProjectId ?? selectedProjectId;
  const project = projects.find((p) => p.id === projectId);
  const terminalPanelVisible = projectId ? (panelVisibleByProject[projectId] ?? false) : false;
  const tabs = useTerminalStore((s) => s.tabs);
  const runningWithPort = tabs.filter(
    (tab) => tab.projectId === projectId && tab.commandId && tab.alive && tab.port,
  );

  /** Update the ?panel= query param in the URL without a full navigation. */
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

  return (
    <div className="flex shrink-0 items-center gap-2">
      {!hideStartup && !activeThreadIsScratch && projectId && (
        <StartupCommandsPopover
          projectId={projectId}
          threadId={activeThreadId ?? undefined}
          worktreeBranch={activeThreadBranch}
        />
      )}
      {!activeThreadIsScratch && runningWithPort.length > 0 && (
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
      {!hideTerminal && !activeThreadIsScratch && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => {
                if (!projectId) return;
                const projectTabs = tabs.filter((t) => t.projectId === projectId);

                if (projectTabs.length === 0 && !terminalPanelVisible) {
                  const cwd = activeThreadWorktreePath || project?.path || 'C:\\';
                  const id = crypto.randomUUID();
                  const label = 'Terminal 1';
                  addTab({
                    id,
                    label,
                    cwd,
                    alive: true,
                    projectId,
                    type: isTauri ? undefined : 'pty',
                  });
                  setPanelVisible(projectId, true);
                } else {
                  toggleTerminalPanel(projectId);
                }
              }}
              data-testid="header-toggle-terminal"
              className={terminalPanelVisible ? 'text-foreground' : 'text-muted-foreground'}
            >
              <Terminal className="icon-base" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            <ShortcutHint label={t('terminal.toggle', 'Toggle Terminal')} keys={['Ctrl', '`']} />
          </TooltipContent>
        </Tooltip>
      )}
      {(activeThreadCanShowGit ||
        (!activeThreadId && selectedProjectId && !activeThreadIsScratch)) && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() =>
                startTransition(() => {
                  if (reviewPaneOpen && rightPaneTab === 'review') {
                    setReviewPaneOpen(false);
                    updatePanelParam(null);
                  } else {
                    setReviewPaneOpen(true);
                    updatePanelParam('review');
                  }
                })
              }
              data-testid="header-toggle-review"
              className={
                reviewPaneOpen && rightPaneTab === 'review'
                  ? 'text-foreground'
                  : 'text-muted-foreground'
              }
            >
              <GitCompare className="icon-base" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            <ShortcutHint label={t('review.title')} keys={['Alt', 'G']} />
          </TooltipContent>
        </Tooltip>
      )}
      {!hideTests && !activeThreadIsScratch && (
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
      )}
      {!hideFiles && !activeThreadIsScratch && (
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
          <TooltipContent>
            <ShortcutHint label={t('projectFiles.title', 'Project Files')} keys={['Alt', 'F']} />
          </TooltipContent>
        </Tooltip>
      )}
      {activeThreadId && canShowComments && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() =>
                startTransition(() => {
                  if (reviewPaneOpen && rightPaneTab === 'comments') {
                    setCommentsPaneOpen(false);
                    updatePanelParam(null);
                  } else {
                    setCommentsPaneOpen(true);
                    updatePanelParam('comments');
                  }
                })
              }
              data-testid="header-toggle-comments"
              className={cn(
                'relative',
                reviewPaneOpen && rightPaneTab === 'comments'
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
      )}
      {activeThreadId && projectId && !activeThreadIsScratch && (
        <ShareThreadButton threadId={activeThreadId} projectId={projectId} />
      )}
      {activeThreadId && (
        <MoreActionsMenu
          onOpenInEditor={!activeThreadIsScratch ? handleOpenInEditor : undefined}
          editorLabels={!activeThreadIsScratch ? editorLabels : undefined}
          hideTimeline={hideTimeline}
        />
      )}
      {trailing}
    </div>
  );
});

interface ProjectHeaderProps {
  hideFiles?: boolean;
  hideTests?: boolean;
  hideStartup?: boolean;
  hideTerminal?: boolean;
  hideTimeline?: boolean;
  /**
   * Suppress the entire thread action cluster (review/files/tests/comments/
   * share/more). Used by the grid column header (`ThreadColumn`), where those
   * actions are consolidated into the grid's view header bound to the selected
   * thread. `trailing` (e.g. the per-cell remove button) is still rendered.
   */
  hideActions?: boolean;
  leading?: ReactNode;
  trailing?: ReactNode;
}

export const ProjectHeader = memo(function ProjectHeader({
  hideFiles = false,
  hideTests = false,
  hideStartup = false,
  hideTerminal = false,
  hideTimeline = false,
  hideActions = false,
  leading,
  trailing,
}: ProjectHeaderProps = {}) {
  const { t } = useTranslation();
  const navigate = useStableNavigate();
  const activeThreadId = useThreadId();
  const activeThreadProjectId = useThreadProjectId();
  const activeThreadTitle = useThreadSelector((t) => t?.title);
  const activeThreadIsScratch = useThreadSelector((t) => variant.isScratch(t));
  const activeThreadParentId = useThreadSelector((t) => t?.parentThreadId);
  const activeThreadTemplateId = useThreadSelector((t) => t?.agentTemplateId);
  const activeTemplate = useAgentTemplateStore((s) =>
    activeThreadTemplateId ? s.templates.find((t) => t.id === activeThreadTemplateId) : undefined,
  );
  const renameThread = useThreadStore((s) => s.renameThread);
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const titleInputRef = useRef<HTMLInputElement>(null);

  const startEditingTitle = useCallback(() => {
    if (!activeThreadId) return;
    setTitleDraft(activeThreadTitle ?? '');
    setIsEditingTitle(true);
  }, [activeThreadId, activeThreadTitle]);

  const commitTitleEdit = useCallback(() => {
    if (!activeThreadId || !activeThreadProjectId) {
      setIsEditingTitle(false);
      return;
    }
    const next = titleDraft.trim();
    if (next && next !== (activeThreadTitle ?? '').trim()) {
      renameThread(activeThreadId, activeThreadProjectId, next);
      toast.success(t('toast.threadRenamed', { title: next }));
    }
    setIsEditingTitle(false);
  }, [activeThreadId, activeThreadProjectId, activeThreadTitle, renameThread, t, titleDraft]);

  const cancelTitleEdit = useCallback(() => {
    setIsEditingTitle(false);
  }, []);

  useEffect(() => {
    if (isEditingTitle) {
      titleInputRef.current?.focus();
      titleInputRef.current?.select();
    }
  }, [isEditingTitle]);

  useEffect(() => {
    setIsEditingTitle(false);
  }, [activeThreadId]);

  const selectedProjectId = useProjectStore((s) => s.selectedProjectId);
  const setReviewPaneOpen = useUIStore((s) => s.setReviewPaneOpen);
  const kanbanContext = useUIStore((s) => s.kanbanContext);
  const fetchForThread = useGitStatusStore((s) => s.fetchForThread);
  const fetchProjectStatus = useGitStatusStore((s) => s.fetchProjectStatus);

  const projectId = activeThreadProjectId ?? selectedProjectId;
  // Fetch git status when activeThread changes
  useEffect(() => {
    if (activeThreadId) {
      fetchForThread(activeThreadId);
    } else if (selectedProjectId) {
      fetchProjectStatus(selectedProjectId);
    }
  }, [activeThreadId, selectedProjectId, fetchForThread, fetchProjectStatus]);

  const handleBackToKanban = useCallback(() => {
    if (!kanbanContext) return;

    const targetProjectId = kanbanContext.projectId || '__all__';
    const basePath = kanbanContext.viewMode === 'list' ? '/list' : '/kanban';

    // Close the review pane when returning to the board/list
    setReviewPaneOpen(false);

    // Navigate back to the originating view (list or kanban).
    // kanbanContext is cleared by useRouteSync when it detects the route,
    // ensuring both allThreadsProjectId and kanbanContext update in the same render.
    const params = new URLSearchParams();
    if (targetProjectId !== '__all__') params.set('project', targetProjectId);
    if (kanbanContext.search) params.set('search', kanbanContext.search);
    if (kanbanContext.caseSensitive) params.set('cs', '1');
    if (kanbanContext.threadId) params.set('highlight', kanbanContext.threadId);
    const qs = params.toString();
    navigate(buildPath(qs ? `${basePath}?${qs}` : basePath));
  }, [kanbanContext, navigate, setReviewPaneOpen]);

  if (!projectId && !activeThreadIsScratch) return null;

  return (
    <div className="border-border flex h-12 items-center border-b px-4 py-2">
      <div className="flex w-full items-center justify-between">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {leading}
          {kanbanContext && activeThreadId && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  data-testid="header-back-kanban"
                  variant="ghost"
                  size="icon-sm"
                  onClick={handleBackToKanban}
                  className="text-muted-foreground hover:text-foreground shrink-0"
                >
                  <ArrowLeft className="icon-base" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                {kanbanContext.viewMode === 'list'
                  ? t('allThreads.backToList', 'Back to list')
                  : t('kanban.backToBoard', 'Back to Kanban')}
              </TooltipContent>
            </Tooltip>
          )}
          {!kanbanContext && activeThreadParentId && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  data-testid="header-back-parent"
                  variant="ghost"
                  size="icon-sm"
                  onClick={() =>
                    navigate(
                      buildPath(
                        `/projects/${activeThreadProjectId}/threads/${activeThreadParentId}`,
                      ),
                    )
                  }
                  className="text-muted-foreground hover:text-foreground shrink-0"
                >
                  <ArrowLeft className="icon-base" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('thread.backToParent', 'Back to parent thread')}</TooltipContent>
            </Tooltip>
          )}
          <Breadcrumb className="min-w-0">
            <BreadcrumbList>
              {activeThreadId && (
                <BreadcrumbItem className="max-w-[240px] min-w-0 sm:max-w-[360px] md:max-w-[520px]">
                  {isEditingTitle ? (
                    <span className="inline-grid max-w-full min-w-0 justify-start justify-items-start">
                      <span
                        aria-hidden
                        className="invisible col-start-1 row-start-1 overflow-hidden text-left text-sm font-medium whitespace-pre"
                      >
                        {titleDraft || ' '}
                      </span>
                      <input
                        ref={titleInputRef}
                        data-testid="header-thread-title-input"
                        value={titleDraft}
                        onChange={(e) => setTitleDraft(e.target.value)}
                        onBlur={commitTitleEdit}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            commitTitleEdit();
                          } else if (e.key === 'Escape') {
                            e.preventDefault();
                            cancelTitleEdit();
                          }
                        }}
                        className="text-foreground col-start-1 row-start-1 w-full min-w-0 border-0 bg-transparent p-0 text-left text-sm font-medium ring-0 outline-hidden focus:ring-0 focus:outline-hidden"
                      />
                    </span>
                  ) : (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span
                          role="button"
                          tabIndex={0}
                          data-testid="header-thread-title"
                          onClick={startEditingTitle}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              startEditingTitle();
                            }
                          }}
                          className="hover:text-accent-foreground block max-w-full min-w-0 cursor-text"
                        >
                          <ThreadTitle
                            as="span"
                            title={activeThreadTitle ?? ''}
                            density="title"
                            className="text-sm font-medium"
                            containerClassName="max-w-full"
                          />
                        </span>
                      </TooltipTrigger>
                      <TooltipContent>{t('thread.renameTitle', 'Click to rename')}</TooltipContent>
                    </Tooltip>
                  )}
                </BreadcrumbItem>
              )}
              {activeTemplate && (
                <>
                  <BreadcrumbSeparator />
                  <BreadcrumbItem className="shrink-0">
                    <span
                      className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium"
                      style={{
                        backgroundColor: activeTemplate.color
                          ? `${activeTemplate.color}22`
                          : 'hsl(var(--muted))',
                        color: activeTemplate.color ?? 'hsl(var(--muted-foreground))',
                      }}
                      data-testid="project-header-template-badge"
                    >
                      {activeTemplate.color && (
                        <span
                          className="inline-block size-2 rounded-full"
                          style={{ backgroundColor: activeTemplate.color }}
                        />
                      )}
                      {activeTemplate.name}
                    </span>
                  </BreadcrumbItem>
                </>
              )}
            </BreadcrumbList>
          </Breadcrumb>
        </div>
        {hideActions ? (
          trailing ? (
            <div className="flex shrink-0 items-center gap-2">{trailing}</div>
          ) : null
        ) : (
          <ThreadHeaderActions
            hideFiles={hideFiles}
            hideTests={hideTests}
            hideStartup={hideStartup}
            hideTerminal={hideTerminal}
            hideTimeline={hideTimeline}
            trailing={trailing}
          />
        )}
      </div>
    </div>
  );
});
