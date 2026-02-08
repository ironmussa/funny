import { useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppStore } from '@/stores/app-store';
import { api } from '@/lib/api';
import { FolderPicker } from './FolderPicker';
import { SettingsPanel } from './SettingsPanel';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  FolderOpen,
  Plus,
  Archive,
  ChevronRight,
  Clock,
  Loader2,
  CheckCircle2,
  XCircle,
  Square,
  Settings,
} from 'lucide-react';
import type { ThreadStatus } from '@a-parallel/shared';

const statusIcon: Record<ThreadStatus, { icon: typeof Clock; className: string }> = {
  pending: { icon: Clock, className: 'text-yellow-400' },
  running: { icon: Loader2, className: 'text-blue-400 animate-spin' },
  completed: { icon: CheckCircle2, className: 'text-green-400' },
  failed: { icon: XCircle, className: 'text-red-400' },
  stopped: { icon: Square, className: 'text-gray-400' },
};

function timeAgo(dateStr: string): string {
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (seconds < 60) return 'now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  return `${Math.floor(days / 30)}mo`;
}

export function Sidebar() {
  const navigate = useNavigate();
  const {
    projects,
    threadsByProject,
    selectedThreadId,
    expandedProjects,
    toggleProject,
    loadProjects,
    startNewThread,
    archiveThread,
    settingsOpen,
    setSettingsOpen,
    setActiveSettingsPage,
  } = useAppStore();

  const [hoveredProjectId, setHoveredProjectId] = useState<string | null>(null);
  const [addingProject, setAddingProject] = useState(false);
  const [newProjectName, setNewProjectName] = useState('');
  const [newProjectPath, setNewProjectPath] = useState('');
  const [folderPickerOpen, setFolderPickerOpen] = useState(false);
  const [archiveConfirm, setArchiveConfirm] = useState<{
    threadId: string;
    projectId: string;
    title: string;
  } | null>(null);

  const handleArchiveConfirm = useCallback(async () => {
    if (!archiveConfirm) return;
    const { threadId, projectId } = archiveConfirm;
    const wasSelected = selectedThreadId === threadId;
    await archiveThread(threadId, projectId);
    setArchiveConfirm(null);
    toast.success('Thread archived successfully');
    if (wasSelected) navigate(`/projects/${projectId}`);
  }, [archiveConfirm, selectedThreadId, archiveThread, navigate]);

  const handleAddProject = async () => {
    if (!newProjectName || !newProjectPath) return;
    try {
      await api.createProject(newProjectName, newProjectPath);
      await loadProjects();
      setAddingProject(false);
      setNewProjectName('');
      setNewProjectPath('');
    } catch (e: any) {
      if (e.message?.includes('Not a git repository')) {
        const init = confirm(
          `"${newProjectPath}" is not a git repository.\n\nDo you want to initialize it with git init?`
        );
        if (init) {
          try {
            await fetch('/api/browse/git-init', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ path: newProjectPath }),
            });
            await api.createProject(newProjectName, newProjectPath);
            await loadProjects();
            setAddingProject(false);
            setNewProjectName('');
            setNewProjectPath('');
          } catch (initErr: any) {
            alert(initErr.message);
          }
        }
      } else {
        alert(e.message);
      }
    }
  };

  if (settingsOpen) {
    return <SettingsPanel />;
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="p-3 border-b border-border flex items-center justify-between">
        <h1 className="text-sm font-semibold tracking-tight">a-parallel</h1>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={() => { setActiveSettingsPage('general'); setSettingsOpen(true); }}
              className="text-muted-foreground hover:text-foreground"
            >
              <Settings className="h-3.5 w-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right">Settings</TooltipContent>
        </Tooltip>
      </div>

      {/* Add project header */}
      <div className="px-2 pt-2 pb-1">
        <div className="group/projects flex items-center justify-between mb-1">
          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            Projects
          </span>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={() => setAddingProject(!addingProject)}
                className="text-muted-foreground opacity-0 group-hover/projects:opacity-100 transition-opacity"
              >
                <Plus className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="right">Add project</TooltipContent>
          </Tooltip>
        </div>

        {addingProject && (
          <div className="space-y-1.5 mb-2 animate-slide-down">
            <input
              className="w-full rounded-md border border-input bg-background px-2 py-1 text-xs transition-[border-color,box-shadow] duration-150 focus:outline-none focus:ring-1 focus:ring-ring"
              placeholder="Project name"
              value={newProjectName}
              onChange={(e) => setNewProjectName(e.target.value)}
            />
            <div className="flex gap-1">
              <input
                className="flex-1 rounded-md border border-input bg-background px-2 py-1 text-xs transition-[border-color,box-shadow] duration-150 focus:outline-none focus:ring-1 focus:ring-ring"
                placeholder="Absolute path"
                value={newProjectPath}
                onChange={(e) => setNewProjectPath(e.target.value)}
              />
              <Button
                variant="outline"
                size="icon-xs"
                onClick={() => setFolderPickerOpen(true)}
                title="Browse for folder"
              >
                <FolderOpen className="h-3.5 w-3.5" />
              </Button>
            </div>
            <Button
              size="sm"
              className="w-full h-7 text-xs"
              onClick={handleAddProject}
            >
              Add
            </Button>
          </div>
        )}
      </div>

      {/* Project accordion list */}
      <ScrollArea className="flex-1 px-2 pb-2">
        {projects.map((project) => {
          const isExpanded = expandedProjects.has(project.id);
          const threads = threadsByProject[project.id] ?? [];

          return (
            <Collapsible
              key={project.id}
              open={isExpanded}
              onOpenChange={() => {
                toggleProject(project.id);
                navigate(`/projects/${project.id}`);
              }}
              className="mb-1 min-w-0 overflow-hidden"
            >
              {/* Project header row */}
              <div
                className="flex items-center rounded-md hover:bg-accent/50 transition-colors"
                onMouseEnter={() => setHoveredProjectId(project.id)}
                onMouseLeave={() => setHoveredProjectId(null)}
              >
                <CollapsibleTrigger className="flex-1 flex items-center gap-1.5 px-2 py-1.5 text-xs text-left text-muted-foreground hover:text-foreground min-w-0 transition-colors">
                  <ChevronRight
                    className={cn(
                      'h-3 w-3 flex-shrink-0 transition-transform duration-200',
                      isExpanded && 'rotate-90'
                    )}
                  />
                  <FolderOpen className="h-3.5 w-3.5 flex-shrink-0" />
                  <span className="truncate font-medium">{project.name}</span>
                </CollapsibleTrigger>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      onClick={(e) => {
                        e.stopPropagation();
                        startNewThread(project.id);
                        navigate(`/projects/${project.id}`);
                      }}
                      className={cn(
                        'mr-1 text-muted-foreground transition-opacity',
                        hoveredProjectId === project.id
                          ? 'opacity-100'
                          : 'opacity-0 pointer-events-none'
                      )}
                    >
                      <Plus className="h-3.5 w-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="right">New thread</TooltipContent>
                </Tooltip>
              </div>

              {/* Threads inside accordion */}
              <CollapsibleContent className="data-[state=open]:animate-slide-down">
                <div className="ml-3 border-l border-border/50 pl-1 mt-0.5 space-y-0.5 min-w-0 overflow-hidden">
                  {threads.length === 0 && (
                    <p className="text-[10px] text-muted-foreground px-2 py-2">
                      No threads yet
                    </p>
                  )}
                  {threads.map((t) => (
                    <div
                      key={t.id}
                      className={cn(
                        'group/thread relative flex items-start rounded-md transition-colors min-w-0 overflow-hidden',
                        selectedThreadId === t.id
                          ? 'bg-accent text-accent-foreground'
                          : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
                      )}
                    >
                      <button
                        onClick={() => navigate(`/projects/${project.id}/threads/${t.id}`)}
                        className="w-full flex flex-col gap-0.5 pl-2 pr-8 py-1.5 text-left min-w-0"
                      >
                        <div className="flex items-center gap-1.5 min-w-0">
                          {(() => {
                            const s = statusIcon[t.status as ThreadStatus] ?? statusIcon.pending;
                            const Icon = s.icon;
                            return <Icon className={cn('h-3 w-3 flex-shrink-0', s.className)} />;
                          })()}
                          <span className="text-[11px] leading-tight truncate">{t.title}</span>
                        </div>
                        {t.branch && (
                          <div className="flex items-center gap-1.5 ml-[18px] min-w-0">
                            <span className="text-[10px] text-muted-foreground truncate">
                              {t.branch}
                            </span>
                          </div>
                        )}
                      </button>
                      <div className="absolute right-1 top-1/2 -translate-y-1/2 grid place-items-center">
                        <span className="col-start-1 row-start-1 text-[10px] text-muted-foreground group-hover/thread:hidden">
                          {timeAgo(t.createdAt)}
                        </span>
                        {t.status !== 'running' && (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setArchiveConfirm({
                                    threadId: t.id,
                                    projectId: project.id,
                                    title: t.title,
                                  });
                                }}
                                className="col-start-1 row-start-1 opacity-0 group-hover/thread:opacity-100 transition-opacity text-muted-foreground hover:text-foreground"
                              >
                                <Archive className="h-3 w-3" />
                              </button>
                            </TooltipTrigger>
                            <TooltipContent side="right">Archive</TooltipContent>
                          </Tooltip>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </CollapsibleContent>
            </Collapsible>
          );
        })}
      </ScrollArea>

      {folderPickerOpen && (
        <FolderPicker
          onSelect={async (path) => {
            setNewProjectPath(path);
            setFolderPickerOpen(false);
            if (!newProjectName) {
              try {
                const res = await fetch(`/api/browse/repo-name?path=${encodeURIComponent(path)}`);
                const data = await res.json();
                if (data.name) setNewProjectName(data.name);
              } catch {
                const folderName = path.split(/[\\/]/).filter(Boolean).pop() || '';
                setNewProjectName(folderName);
              }
            }
          }}
          onClose={() => setFolderPickerOpen(false)}
        />
      )}

      {/* Archive confirmation dialog */}
      <Dialog
        open={!!archiveConfirm}
        onOpenChange={(open) => { if (!open) setArchiveConfirm(null); }}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Archive thread</DialogTitle>
            <DialogDescription>
              Are you sure you want to archive{' '}
              <span className="font-medium text-foreground">
                "{archiveConfirm?.title}"
              </span>
              ? You can restore it later from Settings.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setArchiveConfirm(null)}>
              Cancel
            </Button>
            <Button size="sm" onClick={handleArchiveConfirm}>
              Archive
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

    </div>
  );
}
