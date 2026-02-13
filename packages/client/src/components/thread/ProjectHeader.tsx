import { memo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '@/stores/app-store';
import { useTerminalStore } from '@/stores/terminal-store';
import { editorLabels, type Editor } from '@/stores/settings-store';
import { usePreviewWindow } from '@/hooks/use-preview-window';
import { GitCommit, GitCompare, Globe, Terminal, ExternalLink } from 'lucide-react';
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

function CommitButton() {
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

export const ProjectHeader = memo(function ProjectHeader() {
  const { t } = useTranslation();
  const activeThread = useAppStore(s => s.activeThread);
  const selectedProjectId = useAppStore(s => s.selectedProjectId);
  const projects = useAppStore(s => s.projects);
  const setReviewPaneOpen = useAppStore(s => s.setReviewPaneOpen);
  const reviewPaneOpen = useAppStore(s => s.reviewPaneOpen);
  const { openPreview, isTauri } = usePreviewWindow();
  const toggleTerminalPanel = useTerminalStore(s => s.togglePanel);
  const terminalPanelVisible = useTerminalStore(s => s.panelVisible);
  const setPanelVisible = useTerminalStore(s => s.setPanelVisible);
  const addTab = useTerminalStore(s => s.addTab);

  const projectId = activeThread?.projectId ?? selectedProjectId;
  const project = projects.find(p => p.id === projectId);
  const tabs = useTerminalStore((s) => s.tabs);
  const runningWithPort = tabs.filter(
    (tab) => tab.projectId === projectId && tab.commandId && tab.alive && tab.port
  );

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
        <div className="flex items-center gap-2 min-w-0">
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
              <BreadcrumbItem className="overflow-hidden">
                <BreadcrumbPage className="text-sm truncate">
                  {activeThread.title}
                </BreadcrumbPage>
              </BreadcrumbItem>
            )}
          </BreadcrumbList>
        </Breadcrumb>
        </div>
        <div className="flex items-center gap-2">
          {isTauri && runningWithPort.length > 0 && (
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
          <CommitButton />
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
                size="icon-sm"
                onClick={() => setReviewPaneOpen(!reviewPaneOpen)}
                className={reviewPaneOpen ? 'text-primary' : 'text-muted-foreground'}
              >
                <GitCompare className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('review.title')}</TooltipContent>
          </Tooltip>
        </div>
      </div>
    </div>
  );
});
