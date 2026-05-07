import type { StartupCommand, Message, ToolCall, ThreadStage } from '@funny/shared';
import {
  GitCompare,
  GitFork,
  GitBranch,
  Globe,
  Terminal,
  ExternalLink,
  Pin,
  PinOff,
  Rocket,
  Play,
  Square,
  Loader2,
  Columns3,
  ArrowLeft,
  Milestone,
  Copy,
  ClipboardList,
  Check,
  EllipsisVertical,
  Trash2,
  FolderOpen,
  FlaskConical,
  Activity,
  Sparkles,
} from 'lucide-react';
import { memo, useState, useEffect, useCallback, useRef, startTransition } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation } from 'react-router-dom';
import { toast } from 'sonner';

import { ConfirmDialog } from '@/components/ConfirmDialog';
import { DiffStats } from '@/components/DiffStats';
import {
  Breadcrumb,
  BreadcrumbList,
  BreadcrumbItem,
  BreadcrumbLink,
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
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useCopyToClipboard } from '@/hooks/use-copy-to-clipboard';
import { usePreviewWindow } from '@/hooks/use-preview-window';
import { useStableNavigate } from '@/hooks/use-stable-navigate';
import { api } from '@/lib/api';
import { getEditorLabel } from '@/lib/editor-utils';
import { stageConfig } from '@/lib/thread-utils';
import { buildPath } from '@/lib/url';
import { resolveThreadBranch } from '@/lib/utils';
import { useAgentTemplateStore } from '@/stores/agent-template-store';
import { useGitStatusStore, useGitStatusForThread } from '@/stores/git-status-store';
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

const MoreActionsMenu = memo(function MoreActionsMenu() {
  const { t } = useTranslation();
  const navigate = useStableNavigate();
  const threadId = useThreadId();
  const threadProjectId = useThreadProjectId();
  const threadTitle = useThreadSelector((t) => t?.title);
  const threadMode = useThreadSelector((t) => t?.mode);
  const threadBranch = useThreadSelector((t) => (t ? resolveThreadBranch(t) : undefined));
  const threadPinned = useThreadSelector((t) => t?.pinned);
  const threadStage = useThreadSelector((t) => t?.stage);
  const hasMessages = useThreadSelector((t) => (t?.messages?.length ?? 0) > 0);
  const pinThread = useThreadStore((s) => s.pinThread);
  const updateThreadStage = useThreadStore((s) => s.updateThreadStage);
  const timelineVisible = useUIStore((s) => s.timelineVisible);
  const setTimelineVisible = useUIStore((s) => s.setTimelineVisible);
  const reviewPaneOpen = useUIStore((s) => s.reviewPaneOpen);
  const setReviewPaneOpen = useUIStore((s) => s.setReviewPaneOpen);
  const rightPaneTab = useUIStore((s) => s.rightPaneTab);
  const setActivityPaneOpen = useUIStore((s) => s.setActivityPaneOpen);
  const activityActive = reviewPaneOpen && rightPaneTab === 'activity';
  const showStage = !!threadId && !!threadStage && threadStage !== 'archived';
  const [copiedText, copyText] = useCopyToClipboard();
  const [copiedTools, copyTools] = useCopyToClipboard();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const isWorktree = threadMode === 'worktree' && !!threadBranch;
  const threadStatus = useThreadStatus();
  const isBusy = threadStatus === 'running' || threadStatus === 'setting_up';
  const canConvertToWorktree = threadMode !== 'worktree' && !isBusy;

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
    const projId = thread?.projectId;
    const title = thread?.title;
    if (!projId) return;
    setDeleteLoading(true);
    await useThreadStore.getState().deleteThread(threadId, projId);
    setDeleteLoading(false);
    setDeleteOpen(false);
    toast.success(t('toast.threadDeleted', { title }));
    navigate(buildPath(`/projects/${projId}`));
  }, [navigate, t, threadId]);

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
          {(showStage || threadId) && (
            <>
              {showStage && (
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger data-testid="header-menu-stage">
                    {(() => {
                      const StageIcon = stageConfig[threadStage!].icon;
                      return <StageIcon className="icon-base mr-2" />;
                    })()}
                    {t('kanban.stage', 'Stage')}
                    <span className="ml-auto pl-2 text-xs text-muted-foreground">
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
              {threadId && (
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
          {threadId && (
            <DropdownMenuItem
              data-testid="header-menu-toggle-timeline"
              onClick={() => setTimelineVisible(!timelineVisible)}
              className="cursor-pointer"
            >
              <Milestone className={`icon-base mr-2 ${timelineVisible ? 'text-primary' : ''}`} />
              {t('thread.toggleTimeline', 'Toggle Timeline')}
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
          {threadId && canConvertToWorktree && (
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
                onClick={() => pinThread(threadId, threadProjectId!, !threadPinned)}
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
                className="cursor-pointer text-status-error focus:text-status-error"
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

function StartupCommandsPopover({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const [commands, setCommands] = useState<StartupCommand[]>([]);
  const [open, setOpen] = useState(false);

  const tabs = useTerminalStore((s) => s.tabs);
  const runningIds = new Set<string>();
  for (const tab of tabs) {
    if (tab.commandId && tab.alive) runningIds.add(tab.commandId);
  }

  const loadCommands = useCallback(async () => {
    const result = await api.listCommands(projectId);
    if (result.isOk()) setCommands(result.value);
  }, [projectId]);

  useEffect(() => {
    if (open) loadCommands();
  }, [open, loadCommands]);

  const handleRun = async (cmd: StartupCommand) => {
    const store = useTerminalStore.getState();
    store.addTab({
      id: crypto.randomUUID(),
      label: cmd.label,
      cwd: '',
      alive: true,
      commandId: cmd.id,
      projectId,
    });
    await api.runCommand(projectId, cmd.id);
  };

  const handleStop = async (cmd: StartupCommand) => {
    await api.stopCommand(projectId, cmd.id);
  };

  const anyRunning = commands.some((cmd) => runningIds.has(cmd.id));

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              data-testid="header-startup-commands"
              variant="ghost"
              size="icon-sm"
              className={anyRunning ? 'text-status-success' : 'text-muted-foreground'}
            >
              <Rocket className="icon-base" />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>{t('startup.title', 'Startup Commands')}</TooltipContent>
      </Tooltip>
      <PopoverContent align="end" className="w-64 p-2">
        {commands.length === 0 ? (
          <p className="py-3 text-center text-xs text-muted-foreground">
            {t('startup.noCommands')}
          </p>
        ) : (
          <div className="space-y-1">
            {commands.map((cmd) => {
              const isRunning = runningIds.has(cmd.id);
              return (
                <div
                  key={cmd.id}
                  className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-accent/50"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      {isRunning && (
                        <Loader2 className="icon-xs flex-shrink-0 animate-spin text-status-success" />
                      )}
                      <span className="truncate text-sm">{cmd.label}</span>
                    </div>
                    <span className="mt-0.5 block truncate font-mono text-xs text-muted-foreground">
                      {cmd.command}
                    </span>
                  </div>
                  {isRunning ? (
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      onClick={() => handleStop(cmd)}
                      className="flex-shrink-0 text-status-error hover:text-status-error/80"
                    >
                      <Square className="icon-xs" />
                    </Button>
                  ) : (
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      onClick={() => handleRun(cmd)}
                      className="flex-shrink-0 text-status-success hover:text-status-success/80"
                    >
                      <Play className="icon-xs" />
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

const VISIBLE_STAGES: ThreadStage[] = ['backlog', 'planning', 'in_progress', 'review', 'done'];

export const ProjectHeader = memo(function ProjectHeader() {
  const { t } = useTranslation();
  const navigate = useStableNavigate();
  const location = useLocation();
  const activeThreadId = useThreadId();
  const activeThreadProjectId = useThreadProjectId();
  const activeThreadTitle = useThreadSelector((t) => t?.title);
  const activeThreadStatus = useThreadStatus();
  const activeThreadWorktreePath = useThreadWorktreePath();
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
    }
    setIsEditingTitle(false);
  }, [activeThreadId, activeThreadProjectId, activeThreadTitle, renameThread, titleDraft]);

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
  const projects = useProjectStore((s) => s.projects);
  const setReviewPaneOpen = useUIStore((s) => s.setReviewPaneOpen);
  const reviewPaneOpen = useUIStore((s) => s.reviewPaneOpen);
  const setTestRunnerOpen = useUIStore((s) => s.setTestRunnerOpen);
  const testRunnerOpen = useUIStore((s) => s.testRunnerOpen);
  const setActivityPaneOpen = useUIStore((s) => s.setActivityPaneOpen);
  const rightPaneTab = useUIStore((s) => s.rightPaneTab);
  const kanbanContext = useUIStore((s) => s.kanbanContext);
  const { openPreview, isTauri } = usePreviewWindow();
  const toggleTerminalPanel = useTerminalStore((s) => s.togglePanel);
  const panelVisibleByProject = useTerminalStore((s) => s.panelVisibleByProject);
  const setPanelVisible = useTerminalStore((s) => s.setPanelVisible);
  const addTab = useTerminalStore((s) => s.addTab);
  const terminalPanelVisible = selectedProjectId
    ? (panelVisibleByProject[selectedProjectId] ?? false)
    : false;
  const gitStatus = useGitStatusForThread(activeThreadId ?? undefined);
  const projectGitStatus = useGitStatusStore((s) =>
    !activeThreadId && selectedProjectId ? s.statusByProject[selectedProjectId] : undefined,
  );
  const fetchForThread = useGitStatusStore((s) => s.fetchForThread);
  const fetchProjectStatus = useGitStatusStore((s) => s.fetchProjectStatus);

  const projectId = activeThreadProjectId ?? selectedProjectId;
  const project = projects.find((p) => p.id === projectId);
  const tabs = useTerminalStore((s) => s.tabs);
  const runningWithPort = tabs.filter(
    (tab) => tab.projectId === projectId && tab.commandId && tab.alive && tab.port,
  );
  const effectiveGitStatus = gitStatus ?? projectGitStatus;
  const showGitStats =
    effectiveGitStatus &&
    (effectiveGitStatus.linesAdded > 0 ||
      effectiveGitStatus.linesDeleted > 0 ||
      effectiveGitStatus.dirtyFileCount > 0);
  // Fetch git status when activeThread changes
  useEffect(() => {
    if (activeThreadId) {
      fetchForThread(activeThreadId);
    } else if (selectedProjectId) {
      fetchProjectStatus(selectedProjectId);
    }
  }, [activeThreadId, selectedProjectId, fetchForThread, fetchProjectStatus]);

  // Tooltip ↔ DropdownMenu: suppress tooltip while editor dropdown is open
  const [editorTooltipBlocked, setEditorTooltipBlocked] = useState(false);
  const [editorTooltipOpen, setEditorTooltipOpen] = useState(false);
  const handleEditorDropdown = useCallback((open: boolean) => {
    if (open) {
      setEditorTooltipBlocked(true);
    } else {
      (document.activeElement as HTMLElement)?.blur();
      setTimeout(() => setEditorTooltipBlocked(false), 150);
    }
  }, []);

  /** Update the ?panel= query param in the URL without a full navigation. */
  const updatePanelParam = useCallback(
    (panel: string | null) => {
      const params = new URLSearchParams(location.search);
      if (panel) {
        params.set('panel', panel);
      } else {
        params.delete('panel');
      }
      // Also clear tab param when closing review
      if (!panel || panel !== 'review') {
        params.delete('tab');
      }
      const search = params.toString();
      navigate(`${location.pathname}${search ? `?${search}` : ''}`, { replace: true });
    },
    [location.pathname, location.search, navigate],
  );

  if (!selectedProjectId) return null;

  const handleOpenInEditor = async (editor: Editor) => {
    if (!project) return;
    const folderPath = activeThreadWorktreePath || project.path;
    const result = await api.openInEditor(folderPath, editor);
    if (result.isErr()) {
      toast.error(t('sidebar.openInEditorError', 'Failed to open in editor'));
    }
  };

  const handleBackToKanban = useCallback(() => {
    if (!kanbanContext) return;

    const targetProjectId = kanbanContext.projectId || '__all__';

    // Close the review pane when returning to Kanban
    setReviewPaneOpen(false);

    // Navigate to kanban view.
    // kanbanContext is cleared by useRouteSync when it detects the /kanban route,
    // ensuring both allThreadsProjectId and kanbanContext update in the same render.
    const params = new URLSearchParams();
    if (targetProjectId !== '__all__') params.set('project', targetProjectId);
    if (kanbanContext.search) params.set('search', kanbanContext.search);
    if (kanbanContext.threadId) params.set('highlight', kanbanContext.threadId);
    const qs = params.toString();
    navigate(buildPath(qs ? `/kanban?${qs}` : '/kanban'));
  }, [kanbanContext, navigate, setReviewPaneOpen]);

  return (
    <div className="h-12 border-b border-border px-4 py-2">
      <div className="flex items-center justify-between">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {kanbanContext && activeThreadId && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  data-testid="header-back-kanban"
                  variant="ghost"
                  size="icon-sm"
                  onClick={handleBackToKanban}
                  className="shrink-0 text-muted-foreground hover:text-foreground"
                >
                  <ArrowLeft className="icon-base" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('kanban.backToBoard', 'Back to Kanban')}</TooltipContent>
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
                  className="shrink-0 text-muted-foreground hover:text-foreground"
                >
                  <ArrowLeft className="icon-base" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('thread.backToParent', 'Back to parent thread')}</TooltipContent>
            </Tooltip>
          )}
          <Breadcrumb className="min-w-0">
            <BreadcrumbList>
              {project && activeThreadId && (
                <BreadcrumbItem className="flex-shrink-0">
                  <BreadcrumbLink className="flex cursor-default items-center gap-1.5 whitespace-nowrap text-sm">
                    <FolderOpen className="icon-sm text-muted-foreground" />
                    {project.name}
                  </BreadcrumbLink>
                </BreadcrumbItem>
              )}
              {project && activeThreadId && <BreadcrumbSeparator />}
              {activeThreadId && (
                <BreadcrumbItem className="min-w-0 max-w-[240px] sm:max-w-[360px] md:max-w-[520px]">
                  {isEditingTitle ? (
                    <span className="inline-grid min-w-0 max-w-full justify-start justify-items-start">
                      <span
                        aria-hidden
                        className="invisible col-start-1 row-start-1 overflow-hidden whitespace-pre text-left text-sm font-medium"
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
                        className="col-start-1 row-start-1 w-full min-w-0 border-0 bg-transparent p-0 text-left text-sm font-medium text-foreground outline-none ring-0 focus:outline-none focus:ring-0"
                      />
                    </span>
                  ) : (
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
                      title={t('thread.renameTitle', 'Click to rename')}
                      className="block min-w-0 max-w-full cursor-text truncate text-sm font-medium hover:text-accent-foreground"
                    >
                      {activeThreadTitle}
                    </span>
                  )}
                </BreadcrumbItem>
              )}
              {activeTemplate && (
                <>
                  <BreadcrumbSeparator />
                  <BreadcrumbItem className="flex-shrink-0">
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
                          className="inline-block h-2 w-2 rounded-full"
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
        {activeThreadStatus !== 'setting_up' && (
          <div className="flex flex-shrink-0 items-center gap-2">
            <StartupCommandsPopover projectId={projectId!} />
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
            <DropdownMenu onOpenChange={handleEditorDropdown}>
              <Tooltip
                open={!editorTooltipBlocked && editorTooltipOpen}
                onOpenChange={setEditorTooltipOpen}
              >
                <TooltipTrigger asChild>
                  <DropdownMenuTrigger asChild>
                    <Button
                      data-testid="header-open-editor"
                      variant="ghost"
                      size="icon-sm"
                      className="text-muted-foreground"
                    >
                      <ExternalLink className="icon-base" />
                    </Button>
                  </DropdownMenuTrigger>
                </TooltipTrigger>
                <TooltipContent>
                  {t('sidebar.openInEditor', { editor: getEditorLabel() })}
                </TooltipContent>
              </Tooltip>
              <DropdownMenuContent align="end">
                {(Object.keys(editorLabels) as Editor[]).map((editor) => (
                  <DropdownMenuItem
                    key={editor}
                    onClick={() => handleOpenInEditor(editor)}
                    className="cursor-pointer"
                  >
                    {editorLabels[editor]}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => {
                    if (!selectedProjectId) return;
                    const projectTabs = tabs.filter((t) => t.projectId === selectedProjectId);

                    if (projectTabs.length === 0 && !terminalPanelVisible) {
                      const cwd = activeThreadWorktreePath || project?.path || 'C:\\';
                      const id = crypto.randomUUID();
                      const label = 'Terminal 1';
                      addTab({
                        id,
                        label,
                        cwd,
                        alive: true,
                        projectId: selectedProjectId,
                        type: isTauri ? undefined : 'pty',
                      });
                      setPanelVisible(selectedProjectId, true);
                    } else {
                      toggleTerminalPanel(selectedProjectId);
                    }
                  }}
                  data-testid="header-toggle-terminal"
                  className={terminalPanelVisible ? 'text-foreground' : 'text-muted-foreground'}
                >
                  <Terminal className="icon-base" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('terminal.toggle', 'Toggle Terminal')}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size={showGitStats ? undefined : 'icon-sm'}
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
                  className={`${showGitStats ? 'h-8 px-2' : ''} ${reviewPaneOpen && rightPaneTab === 'review' ? 'text-foreground' : 'text-muted-foreground'}`}
                >
                  {showGitStats ? (
                    <DiffStats
                      linesAdded={effectiveGitStatus.linesAdded}
                      linesDeleted={effectiveGitStatus.linesDeleted}
                      dirtyFileCount={effectiveGitStatus.dirtyFileCount}
                      size="sm"
                      tooltips={false}
                      className="font-semibold"
                    />
                  ) : (
                    <GitCompare className="icon-base" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('review.title')}</TooltipContent>
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
            {activeThreadId && <MoreActionsMenu />}
          </div>
        )}
      </div>
    </div>
  );
});
