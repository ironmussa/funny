import { memo, useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '@/stores/app-store';
import { useTerminalStore } from '@/stores/terminal-store';
import { useGitStatusStore } from '@/stores/git-status-store';
import { editorLabels, type Editor } from '@/stores/settings-store';
import { usePreviewWindow } from '@/hooks/use-preview-window';
import { GitCommit, GitCompare, Globe, Terminal, ExternalLink, Pin, PinOff, Rocket, Play, Square, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { toast } from 'sonner';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
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
import { SidebarTrigger } from '@/components/ui/sidebar';
import { Separator } from '@/components/ui/separator';
import { CommitDialog } from './CommitDialog';
import type { StartupCommand } from '@a-parallel/shared';

function CommitButton({ disabled }: { disabled?: boolean }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setOpen(true)}
            disabled={disabled}
            className={open ? 'text-primary' : 'text-muted-foreground'}
          >
            <GitCommit className="h-4 w-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{t('review.commitTooltip', 'Commit')}</TooltipContent>
      </Tooltip>
      <CommitDialog open={open} onOpenChange={setOpen} />
    </>
  );
}

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
              className={anyRunning ? 'text-green-400' : 'text-muted-foreground'}
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
                        <Loader2 className="h-3 w-3 animate-spin text-green-400 flex-shrink-0" />
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
                      className="text-red-400 hover:text-red-300 flex-shrink-0"
                    >
                      <Square className="h-3 w-3" />
                    </Button>
                  ) : (
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      onClick={() => handleRun(cmd)}
                      className="text-green-400 hover:text-green-300 flex-shrink-0"
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
  const activeThread = useAppStore(s => s.activeThread);
  const selectedProjectId = useAppStore(s => s.selectedProjectId);
  const projects = useAppStore(s => s.projects);
  const setReviewPaneOpen = useAppStore(s => s.setReviewPaneOpen);
  const reviewPaneOpen = useAppStore(s => s.reviewPaneOpen);
  const pinThread = useAppStore(s => s.pinThread);
  const { openPreview, isTauri } = usePreviewWindow();
  const toggleTerminalPanel = useTerminalStore(s => s.togglePanel);
  const terminalPanelVisible = useTerminalStore(s => s.panelVisible);
  const setPanelVisible = useTerminalStore(s => s.setPanelVisible);
  const addTab = useTerminalStore(s => s.addTab);
  const statusByThread = useGitStatusStore(s => s.statusByThread);
  const fetchForThread = useGitStatusStore(s => s.fetchForThread);

  const projectId = activeThread?.projectId ?? selectedProjectId;
  const project = projects.find(p => p.id === projectId);
  const tabs = useTerminalStore((s) => s.tabs);
  const runningWithPort = tabs.filter(
    (tab) => tab.projectId === projectId && tab.commandId && tab.alive && tab.port
  );

  const gitStatus = activeThread ? statusByThread[activeThread.id] : undefined;
  const showGitStats = gitStatus && (gitStatus.linesAdded > 0 || gitStatus.linesDeleted > 0);

  // Fetch git status when activeThread changes
  useEffect(() => {
    if (activeThread) {
      console.log('Fetching git status for thread:', activeThread.id);
      fetchForThread(activeThread.id);
    }
  }, [activeThread?.id, fetchForThread]);

  // Debug: log git status
  if (activeThread && gitStatus) {
    console.log('Git Status for thread:', activeThread.id, gitStatus);
  }

  if (!selectedProjectId) return null;

  const handleOpenInEditor = async (editor: Editor) => {
    if (!project) return;
    const result = await api.openInEditor(project.path, editor);
    if (result.isErr()) {
      toast.error(t('sidebar.openInEditorError', 'Failed to open in editor'));
    }
  };

  return (
    <div className="px-4 py-2 border-b border-border">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 min-w-0 max-w-[50%]">
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="h-4" />
        <Breadcrumb className="min-w-0">
          <BreadcrumbList>
            {project && (
              <BreadcrumbItem className="flex-shrink-0">
                <BreadcrumbLink className="text-sm whitespace-nowrap cursor-default">
                  {project.name}
                </BreadcrumbLink>
              </BreadcrumbItem>
            )}
            {project && activeThread && <BreadcrumbSeparator />}
            {activeThread && (
              <BreadcrumbItem className="overflow-hidden flex-1">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <div className="block w-full cursor-default">
                      <BreadcrumbPage className="text-sm truncate block">
                        {activeThread.title}
                      </BreadcrumbPage>
                    </div>
                  </TooltipTrigger>
                  <TooltipContent>{activeThread.title}</TooltipContent>
                </Tooltip>
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
                  className="text-blue-400 hover:text-blue-300"
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
          {activeThread && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => pinThread(activeThread.id, activeThread.projectId, !activeThread.pinned)}
                  className={activeThread.pinned ? 'text-primary' : 'text-muted-foreground'}
                >
                  {activeThread.pinned ? <PinOff className="h-4 w-4" /> : <Pin className="h-4 w-4" />}
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                {activeThread.pinned ? t('sidebar.unpin', 'Unpin') : t('sidebar.pin', 'Pin')}
              </TooltipContent>
            </Tooltip>
          )}
          <CommitButton disabled={!gitStatus || gitStatus.dirtyFileCount === 0} />
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => {
                  if (!selectedProjectId) return;
                  const projectTabs = tabs.filter(t => t.projectId === selectedProjectId);

                  if (projectTabs.length === 0 && !terminalPanelVisible) {
                    // No tabs for this project and panel is closed — create a new PTY tab
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
                    // Otherwise, just toggle panel visibility
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
                onClick={() => setReviewPaneOpen(!reviewPaneOpen)}
                className={`${showGitStats ? 'h-8 px-2' : 'h-8 w-8'} ${reviewPaneOpen ? 'text-primary' : 'text-muted-foreground'}`}
              >
                {showGitStats ? (
                  <div className="flex items-center gap-2 text-xs font-semibold">
                    <span className="text-green-500">+{gitStatus.linesAdded}</span>
                    <span className="text-red-500">-{gitStatus.linesDeleted}</span>
                  </div>
                ) : (
                  <GitCompare className="h-4 w-4" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('review.title')}</TooltipContent>
          </Tooltip>
        </div>
      </div>
    </div>
  );
});
