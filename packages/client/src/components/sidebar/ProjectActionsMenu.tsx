import type { Project } from '@funny/shared';
import {
  BarChart3,
  EyeOff,
  FolderOpenDot,
  MoreVertical,
  Pencil,
  RotateCcw,
  Settings,
  Sparkles,
  Terminal,
  Trash2,
  Waypoints,
  Zap,
} from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { OpenInEditorSubmenu } from '@/components/OpenInEditorSubmenu';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useStableNavigate } from '@/hooks/use-stable-navigate';
import { api } from '@/lib/api';
import { openDirectoryInEditor } from '@/lib/editor-utils';
import { openProjectTerminal } from '@/lib/open-terminal-tab';
import { toastError } from '@/lib/toast-error';
import { buildPath } from '@/lib/url';
import { cn } from '@/lib/utils';

interface ProjectActionsMenuProps {
  project: Project;
  onRenameProject: (projectId: string, currentName: string) => void;
  onDeleteProject: (projectId: string, name: string) => void;
  onCloseProject?: (projectId: string, name: string) => void;
  onReopenProject?: (projectId: string, name: string) => void;
}

export function ProjectActionsMenu({
  project,
  onRenameProject,
  onDeleteProject,
  onCloseProject,
  onReopenProject,
}: ProjectActionsMenuProps) {
  const navigate = useStableNavigate();
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  const navigateTo = (path: string, state?: { openCreateAutomation: boolean }) => {
    setOpen(false);
    navigate(buildPath(path), state ? { state } : undefined);
  };

  return (
    <div className="mr-2 flex items-center gap-0.5">
      <div
        className={cn(
          'flex items-center gap-0.5',
          open
            ? 'opacity-100'
            : 'opacity-0 pointer-events-none group-hover/project:opacity-100 group-hover/project:pointer-events-auto',
        )}
      >
        <DropdownMenu open={open} onOpenChange={setOpen}>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              tabIndex={-1}
              data-testid={`project-more-actions-${project.id}`}
              onClick={(event) => event.stopPropagation()}
              className="text-muted-foreground hover:text-foreground"
            >
              <MoreVertical className="icon-sm" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="bottom">
            <DropdownMenuItem
              data-testid="project-menu-open-directory"
              onClick={async (event) => {
                event.stopPropagation();
                const result = await api.openDirectory({ path: project.path });
                if (result.isErr()) toastError(result.error);
              }}
            >
              <FolderOpenDot className="icon-sm" />
              {t('sidebar.openDirectory')}
            </DropdownMenuItem>
            <DropdownMenuItem
              data-testid="project-menu-open-terminal"
              onClick={(event) => {
                event.stopPropagation();
                openProjectTerminal({ projectId: project.id, cwd: project.path });
              }}
            >
              <Terminal className="icon-sm" />
              {t('sidebar.openTerminal')}
            </DropdownMenuItem>
            <OpenInEditorSubmenu
              testId="project-menu-open-editor"
              onPick={(editor) => openDirectoryInEditor(project.path, editor)}
            />
            <DropdownMenuItem
              data-testid="project-menu-settings"
              onClick={(event) => {
                event.stopPropagation();
                navigateTo(`/projects/${project.id}/settings/general`);
              }}
            >
              <Settings className="icon-sm" />
              {t('sidebar.settings')}
            </DropdownMenuItem>
            <DropdownMenuItem
              data-testid="project-menu-analytics"
              onClick={(event) => {
                event.stopPropagation();
                navigateTo(`/projects/${project.id}/analytics`);
              }}
            >
              <BarChart3 className="icon-sm" />
              {t('sidebar.analytics')}
            </DropdownMenuItem>
            <DropdownMenuItem
              data-testid="project-menu-workflows"
              onClick={(event) => {
                event.stopPropagation();
                navigateTo(`/projects/${project.id}/workflows`);
              }}
            >
              <Waypoints className="icon-sm" />
              {t('sidebar.workflows')}
            </DropdownMenuItem>
            <DropdownMenuItem
              data-testid="project-menu-view-designs"
              onClick={(event) => {
                event.stopPropagation();
                navigateTo(`/projects/${project.id}/designs`);
              }}
            >
              <Sparkles className="icon-sm" />
              {t('sidebar.viewDesigns')}
            </DropdownMenuItem>
            <DropdownMenuItem
              data-testid="project-menu-create-automation"
              onClick={(event) => {
                event.stopPropagation();
                navigateTo(`/projects/${project.id}/settings/automations`, {
                  openCreateAutomation: true,
                });
              }}
            >
              <Zap className="icon-sm" />
              {t('sidebar.createAutomation')}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              data-testid="project-menu-rename"
              onClick={(event) => {
                event.stopPropagation();
                setOpen(false);
                onRenameProject(project.id, project.name);
              }}
            >
              <Pencil className="icon-sm" />
              {t('sidebar.renameProject')}
            </DropdownMenuItem>
            {onReopenProject ? (
              <DropdownMenuItem
                data-testid="project-menu-reopen"
                onClick={(event) => {
                  event.stopPropagation();
                  setOpen(false);
                  onReopenProject(project.id, project.name);
                }}
              >
                <RotateCcw className="icon-sm" />
                {t('sidebar.reopenProject')}
              </DropdownMenuItem>
            ) : (
              onCloseProject && (
                <DropdownMenuItem
                  data-testid="project-menu-close"
                  onClick={(event) => {
                    event.stopPropagation();
                    setOpen(false);
                    onCloseProject(project.id, project.name);
                  }}
                >
                  <EyeOff className="icon-sm" />
                  {t('sidebar.closeProject')}
                </DropdownMenuItem>
              )
            )}
            <DropdownMenuItem
              data-testid="project-menu-delete"
              onClick={(event) => {
                event.stopPropagation();
                setOpen(false);
                onDeleteProject(project.id, project.name);
              }}
              className="text-status-error focus:text-status-error"
            >
              <Trash2 className="icon-sm" />
              {t('sidebar.deleteProject')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
