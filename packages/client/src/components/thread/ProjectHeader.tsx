import { memo, useState, useEffect, useCallback, startTransition } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useThreadStore } from '@/stores/thread-store';
import { useProjectStore } from '@/stores/project-store';
import { useUIStore } from '@/stores/ui-store';
import { useTerminalStore } from '@/stores/terminal-store';
import { useGitStatusStore } from '@/stores/git-status-store';
import { editorLabels, type Editor } from '@/stores/settings-store';
import { usePreviewWindow } from '@/hooks/use-preview-window';
import { GitCompare, Globe, Terminal, ExternalLink, Pin, PinOff, Rocket, Play, Square, Loader2, Columns3, ArrowLeft, FolderOpen, Copy, ClipboardList, Check, EllipsisVertical, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { toast } from 'sonner';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  Breadcrumb,
  BreadcrumbList,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import type { StartupCommand, Message, ToolCall } from '@funny/shared';

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
        } catch { inputStr = String(tc.input); }
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
  const navigate = useNavigate();
  const threadId = useThreadStore(s => s.activeThread?.id);
  const threadProjectId = useThreadStore(s => s.activeThread?.projectId);
  const threadPinned = useThreadStore(s => s.activeThread?.pinned);
  const hasMessages = useThreadStore(s => (s.activeThread?.messages?.length ?? 0) > 0);
  const pinThread = useThreadStore(s => s.pinThread);
  const deleteThread = useThreadStore(s => s.deleteThread);
  const setReviewPaneOpen = useUIStore(s => s.setReviewPaneOpen);
  const [copiedText, setCopiedText] = useState(false);
  const [copiedTools, setCopiedTools] = useState(false);

  const handleCopy = useCallback((includeToolCalls: boolean) => {
    const messages = useThreadStore.getState().activeThread?.messages;
    if (!messages?.length) return;
    const md = threadToMarkdown(messages, includeToolCalls);
    navigator.clipboard.writeText(md);
    if (includeToolCalls) {
      setCopiedTools(true);
      setTimeout(() => setCopiedTools(false), 2000);
    } else {
      setCopiedText(true);
      setTimeout(() => setCopiedText(false), 2000);
    }
  }, []);

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground"
            >
              <EllipsisVertical className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>{t('thread.moreActions', 'More actions')}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          onClick={() => handleCopy(false)}
          disabled={!hasMessages}
          className="cursor-pointer"
        >
          {copiedText ? <Check className="h-4 w-4 mr-2" /> : <Copy className="h-4 w-4 mr-2" />}
          {t('thread.copyText', 'Copy text only')}
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => handleCopy(true)}
          disabled={!hasMessages}
          className="cursor-pointer"
        >
          {copiedTools ? <Check className="h-4 w-4 mr-2" /> : <ClipboardList className="h-4 w-4 mr-2" />}
          {t('thread.copyWithTools', 'Copy with tool calls')}
        </DropdownMenuItem>
        {threadId && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => pinThread(threadId, threadProjectId!, !threadPinned)}
              className="cursor-pointer"
            >
              {threadPinned
                ? <><PinOff className="h-4 w-4 mr-2" />{t('sidebar.unpin', 'Unpin')}</>
                : <><Pin className="h-4 w-4 mr-2" />{t('sidebar.pin', 'Pin')}</>
              }
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => {
                setReviewPaneOpen(false);
                navigate(`/search?view=board&project=${threadProjectId}&highlight=${threadId}`);
              }}
              className="cursor-pointer"
            >
              <Columns3 className="h-4 w-4 mr-2" />
              {t('kanban.viewOnBoard', 'View on Board')}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => {
                deleteThread(threadId!, threadProjectId!);
                navigate(`/projects/${threadProjectId}`);
              }}
              className="text-status-error focus:text-status-error cursor-pointer"
            >
              <Trash2 className="h-4 w-4 mr-2" />
              {t('common.delete', 'Delete')}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
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
              variant="ghost"
              size="icon-sm"
              className={anyRunning ? 'text-status-success' : 'text-muted-foreground'}
            >
              <Rocket className="h-4 w-4" />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>{t('startup.title', 'Startup Commands')}</TooltipContent>
      </Tooltip>
      <PopoverContent align="end" className="w-64 p-2">
        {commands.length === 0 ? (
          <p className="text-xs text-muted-foreground text-center py-3">
            {t('startup.noCommands')}
          </p>
        ) : (
          <div className="space-y-1">
            {commands.map((cmd) => {
              const isRunning = runningIds.has(cmd.id);
              return (
                <div
                  key={cmd.id}
                  className="flex items-center justify-between gap-2 px-2 py-1.5 rounded-md hover:bg-accent/50 transition-colors"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      {isRunning && (
                        <Loader2 className="h-3 w-3 animate-spin text-status-success flex-shrink-0" />
                      )}
                      <span className="text-sm truncate">{cmd.label}</span>
                    </div>
                    <span className="text-xs text-muted-foreground font-mono truncate block mt-0.5">{cmd.command}</span>
                  </div>
                  {isRunning ? (
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      onClick={() => handleStop(cmd)}
                      className="text-status-error hover:text-status-error/80 flex-shrink-0"
                    >
                      <Square className="h-3 w-3" />
                    </Button>
                  ) : (
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      onClick={() => handleRun(cmd)}
                      className="text-status-success hover:text-status-success/80 flex-shrink-0"
                    >
                      <Play className="h-3 w-3" />
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

export const ProjectHeader = memo(function ProjectHeader() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const activeThreadId = useThreadStore(s => s.activeThread?.id);
  const activeThreadProjectId = useThreadStore(s => s.activeThread?.projectId);
  const activeThreadTitle = useThreadStore(s => s.activeThread?.title);
  const activeThreadWorktreePath = useThreadStore(s => s.activeThread?.worktreePath);
  const activeThreadParentId = useThreadStore(s => s.activeThread?.parentThreadId);
  const selectedProjectId = useProjectStore(s => s.selectedProjectId);
  const projects = useProjectStore(s => s.projects);
  const setReviewPaneOpen = useUIStore(s => s.setReviewPaneOpen);
  const reviewPaneOpen = useUIStore(s => s.reviewPaneOpen);
  const kanbanContext = useUIStore(s => s.kanbanContext);
  const { openPreview, isTauri } = usePreviewWindow();
  const toggleTerminalPanel = useTerminalStore(s => s.togglePanel);
  const terminalPanelVisible = useTerminalStore(s => s.panelVisible);
  const setPanelVisible = useTerminalStore(s => s.setPanelVisible);
  const addTab = useTerminalStore(s => s.addTab);
  const gitStatus = useGitStatusStore(s => activeThreadId ? s.statusByThread[activeThreadId] : undefined);
  const fetchForThread = useGitStatusStore(s => s.fetchForThread);

  const projectId = activeThreadProjectId ?? selectedProjectId;
  const project = projects.find(p => p.id === projectId);
  const tabs = useTerminalStore((s) => s.tabs);
  const runningWithPort = tabs.filter(
    (tab) => tab.projectId === projectId && tab.commandId && tab.alive && tab.port
  );
  const showGitStats = gitStatus && (gitStatus.linesAdded > 0 || gitStatus.linesDeleted > 0);

  // Fetch git status when activeThread changes
  useEffect(() => {
    if (activeThreadId) {
      fetchForThread(activeThreadId);
    }
  }, [activeThreadId, fetchForThread]);

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
    const searchParam = kanbanContext.search ? `&search=${encodeURIComponent(kanbanContext.search)}` : '';
    const highlightParam = kanbanContext.threadId ? `&highlight=${kanbanContext.threadId}` : '';

    // Close the review pane when returning to Kanban
    setReviewPaneOpen(false);

    // Navigate to search view with board mode.
    // kanbanContext is cleared by useRouteSync when it detects the /search route,
    // ensuring both allThreadsProjectId and kanbanContext update in the same render.
    navigate(`/search?view=board${targetProjectId !== '__all__' ? `&project=${targetProjectId}` : ''}${searchParam}${highlightParam}`);
  }, [kanbanContext, navigate, setReviewPaneOpen]);

  return (
    <div className="px-4 py-2 border-b border-border">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 min-w-0 max-w-[50%]">
        {kanbanContext && activeThreadId && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={handleBackToKanban}
                className="text-muted-foreground hover:text-foreground shrink-0"
              >
                <ArrowLeft className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('kanban.backToBoard', 'Back to Kanban')}</TooltipContent>
          </Tooltip>
        )}
        {!kanbanContext && activeThreadParentId && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => navigate(`/projects/${activeThreadProjectId}/threads/${activeThreadParentId}`)}
                className="text-muted-foreground hover:text-foreground shrink-0"
              >
                <ArrowLeft className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('thread.backToParent', 'Back to parent thread')}</TooltipContent>
          </Tooltip>
        )}
        <Breadcrumb className="min-w-0">
          <BreadcrumbList>
            {project && (
              <BreadcrumbItem className="flex-shrink-0">
                <BreadcrumbLink className="text-sm whitespace-nowrap cursor-default flex items-center gap-1.5">
                  <FolderOpen className="h-3.5 w-3.5 text-muted-foreground" />
                  {project.name}
                </BreadcrumbLink>
              </BreadcrumbItem>
            )}
            {project && activeThreadId && <BreadcrumbSeparator />}
            {activeThreadId && (
              <BreadcrumbItem className="overflow-hidden flex-1">
                <BreadcrumbPage className="text-sm truncate block">
                  {activeThreadTitle}
                </BreadcrumbPage>
              </BreadcrumbItem>
            )}
          </BreadcrumbList>
        </Breadcrumb>
        </div>
        <div className="flex items-center gap-2">
          <StartupCommandsPopover projectId={projectId!} />
          {runningWithPort.length > 0 && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
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
                  <Globe className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('preview.openPreview')}</TooltipContent>
            </Tooltip>
          )}
          <DropdownMenu>
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="text-muted-foreground"
                  >
                    <ExternalLink className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent>{t('sidebar.openInEditor', 'Open in Editor')}</TooltipContent>
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
                  const projectTabs = tabs.filter(t => t.projectId === selectedProjectId);

                  if (projectTabs.length === 0 && !terminalPanelVisible) {
                    const cwd = project?.path ?? 'C:\\';
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
                    setPanelVisible(true);
                  } else {
                    toggleTerminalPanel();
                  }
                }}
                className={terminalPanelVisible ? 'text-primary' : 'text-muted-foreground'}
              >
                <Terminal className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('terminal.toggle', 'Toggle Terminal')}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                onClick={() => startTransition(() => setReviewPaneOpen(!reviewPaneOpen))}
                className={`${showGitStats ? 'h-8 px-2' : 'h-8 w-8'} ${reviewPaneOpen ? 'text-primary' : 'text-muted-foreground'}`}
              >
                {showGitStats ? (
                  <div className="flex items-center gap-2 text-xs font-mono font-semibold">
                    <span className="text-status-success">+{gitStatus.linesAdded}</span>
                    <span className="text-status-error">-{gitStatus.linesDeleted}</span>
                  </div>
                ) : (
                  <GitCompare className="h-4 w-4" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('review.title')}</TooltipContent>
          </Tooltip>
          <MoreActionsMenu />
        </div>
      </div>
    </div>
  );
});
