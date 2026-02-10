import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '@/stores/app-store';
import { useTerminalStore } from '@/stores/terminal-store';
import { usePreviewWindow } from '@/hooks/use-preview-window';
import { GitBranch, GitCompare, Globe } from 'lucide-react';
import { Button } from '@/components/ui/button';
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

export const ProjectHeader = memo(function ProjectHeader() {
  const { t } = useTranslation();
  const activeThread = useAppStore(s => s.activeThread);
  const selectedProjectId = useAppStore(s => s.selectedProjectId);
  const projects = useAppStore(s => s.projects);
  const setReviewPaneOpen = useAppStore(s => s.setReviewPaneOpen);
  const reviewPaneOpen = useAppStore(s => s.reviewPaneOpen);
  const { openPreview, isTauri } = usePreviewWindow();

  const projectId = activeThread?.projectId ?? selectedProjectId;
  const project = projects.find(p => p.id === projectId);
  const tabs = useTerminalStore((s) => s.tabs);
  const runningWithPort = tabs.filter(
    (tab) => tab.projectId === projectId && tab.commandId && tab.alive && tab.port
  );

  if (!selectedProjectId) return null;

  const showWorktreeInfo = activeThread && activeThread.branch;

  return (
    <div className="px-4 py-2 border-b border-border">
      <div className="flex items-center justify-between">
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
      {showWorktreeInfo && (
        <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
          {activeThread.branch && (
            <span className="flex items-center gap-1 min-w-0">
              <GitBranch className="h-3 w-3 flex-shrink-0" />
              <span className="truncate">{activeThread.branch}</span>
              {activeThread.baseBranch && (
                <span className="text-muted-foreground/50 flex-shrink-0">from {activeThread.baseBranch}</span>
              )}
            </span>
          )}
        </div>
      )}
    </div>
  );
});
