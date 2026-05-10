import type { Project, Thread } from '@funny/shared';
import { ChevronRight, FolderPlus } from 'lucide-react';
import { type RefObject, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { SidebarContent } from '@/components/ui/sidebar';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useStableNavigate } from '@/hooks/use-stable-navigate';
import { threadsVisuallyEqual } from '@/lib/shallow-compare';
import { buildPath } from '@/lib/url';
import { cn } from '@/lib/utils';

import { ProjectItem } from './ProjectItem';

const EMPTY_THREADS: Thread[] = [];

interface ProjectItemHandlers {
  onToggle: (projectId: string) => void;
  onSelectProject: (projectId: string) => void;
  onNewThread: (projectId: string) => void;
  onRenameProject: (projectId: string, currentName: string) => void;
  onDeleteProject: (projectId: string, name: string) => void;
  onCloseProject: (projectId: string, name: string) => void;
  onReopenProject: (projectId: string, name: string) => void;
  onSelectThread: (projectId: string, threadId: string) => void;
  onRenameThread: (projectId: string, threadId: string, newTitle: string) => void;
  onArchiveThread: (projectId: string, threadId: string, title: string) => void;
  onPinThread: (projectId: string, threadId: string, pinned: boolean) => void;
  onDeleteThread: (projectId: string, threadId: string, title: string) => void;
  onShowAllThreads: (projectId: string) => void;
  onShowIssues: (projectId: string) => void;
}

interface Props extends ProjectItemHandlers {
  projects: Project[];
  projectsInitialized: boolean;
  selectedProjectId: string | null;
  expandedProjects: Set<string>;
  threadsByProject: Record<string, Thread[] | undefined>;
  scrollRef: RefObject<HTMLDivElement | null>;
  topSentinelRef: RefObject<HTMLDivElement | null>;
}

/**
 * Projects header (with "add project" button) + scrollable projects list +
 * top fade gradient. Extracted from Sidebar.tsx so it doesn't need to import
 * ProjectItem, Skeleton, Button, Tooltip, FolderPlus, SidebarContent,
 * shallow-compare directly.
 */
export function SidebarProjectsSection({
  projects,
  projectsInitialized,
  selectedProjectId,
  expandedProjects,
  threadsByProject,
  scrollRef,
  topSentinelRef,
  ...handlers
}: Props) {
  const { t } = useTranslation();
  const navigate = useStableNavigate();
  const [scrolled, setScrolled] = useState(false);
  const [closedExpanded, setClosedExpanded] = useState(false);

  const { onCloseProject, onReopenProject, ...sharedHandlers } = handlers;

  const { activeProjects, closedProjects } = useMemo(() => {
    const active: Project[] = [];
    const closed: Project[] = [];
    for (const p of projects) {
      if (p.closed) closed.push(p);
      else active.push(p);
    }
    return { activeProjects: active, closedProjects: closed };
  }, [projects]);

  useEffect(() => {
    const root = scrollRef.current;
    const sentinel = topSentinelRef.current;
    if (!root || !sentinel) return;
    const io = new IntersectionObserver(
      () => {
        setScrolled(root.scrollTop > 0);
      },
      { root, threshold: 0 },
    );
    io.observe(sentinel);
    return () => io.disconnect();
  }, [scrollRef, topSentinelRef]);

  // Memoize per-project thread lists, preserving referential identity for
  // projects whose threads didn't change visually.
  const prevFilteredRef = useRef<Record<string, Thread[]>>({});
  const filteredThreadsByProject = useMemo(() => {
    const prev = prevFilteredRef.current;
    const result: Record<string, Thread[]> = {};
    for (const project of activeProjects) {
      const src = threadsByProject[project.id];
      const filtered = (Array.isArray(src) ? src : []).filter((thread) => !thread.archived);
      const previous = prev[project.id];
      if (
        previous &&
        previous.length === filtered.length &&
        previous.every((prevT, i) => threadsVisuallyEqual(prevT, filtered[i]))
      ) {
        result[project.id] = previous;
      } else {
        result[project.id] = filtered;
      }
    }
    prevFilteredRef.current = result;
    return result;
  }, [threadsByProject, activeProjects]);

  const threadsLoadedByProject = useMemo(() => {
    const result: Record<string, boolean> = {};
    for (const project of activeProjects) {
      result[project.id] = Array.isArray(threadsByProject[project.id]);
    }
    return result;
  }, [threadsByProject, activeProjects]);

  return (
    <>
      <div className="flex shrink-0 items-center justify-between px-4 pb-2 pt-4">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {t('sidebar.projects')}
        </h2>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              data-testid="sidebar-add-project"
              size="icon"
              className="h-5 w-5 text-muted-foreground hover:text-foreground"
              onClick={() => navigate(buildPath('/new'))}
            >
              <FolderPlus className="icon-sm" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right">{t('sidebar.addProject')}</TooltipContent>
        </Tooltip>
      </div>
      <SidebarContent
        ref={scrollRef}
        className="relative px-2 pb-2 contain-paint"
        onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 0)}
      >
        <div ref={topSentinelRef} aria-hidden className="h-px shrink-0" />
        <div
          className={cn(
            'sticky top-0 left-0 right-0 h-8 -mt-px -mb-8 bg-gradient-to-b from-sidebar to-transparent pointer-events-none z-10 shrink-0',
            scrolled ? 'opacity-100' : 'opacity-0',
          )}
        />
        {!projectsInitialized && projects.length === 0 && (
          <div
            aria-hidden
            data-testid="sidebar-projects-skeleton"
            className="flex flex-col gap-1.5"
          >
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="flex items-center gap-1.5 px-2 py-1">
                <Skeleton className="h-3.5 w-3.5 rounded" />
                <Skeleton className="h-3.5 w-3.5 rounded" />
                <Skeleton className="h-3 flex-1" style={{ maxWidth: `${60 + ((i * 37) % 35)}%` }} />
              </div>
            ))}
          </div>
        )}
        {projectsInitialized && activeProjects.length === 0 && closedProjects.length === 0 && (
          <button
            data-testid="sidebar-no-projects-cta"
            onClick={() => navigate(buildPath('/new'))}
            className="w-full cursor-pointer px-2 py-2 text-left text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            {t('sidebar.noProjects')}
          </button>
        )}
        <div className="flex flex-col gap-1.5">
          {activeProjects.map((project) => (
            <ProjectItem
              key={project.id}
              project={project}
              threads={filteredThreadsByProject[project.id] ?? EMPTY_THREADS}
              threadsLoaded={threadsLoadedByProject[project.id] ?? false}
              isExpanded={expandedProjects.has(project.id)}
              isSelected={selectedProjectId === project.id}
              onCloseProject={onCloseProject}
              {...sharedHandlers}
            />
          ))}
        </div>
        {closedProjects.length > 0 && (
          <Collapsible
            open={closedExpanded}
            onOpenChange={setClosedExpanded}
            className="mt-3"
            data-testid="sidebar-closed-projects"
          >
            <CollapsibleTrigger
              data-testid="sidebar-closed-projects-toggle"
              className="flex w-full items-center gap-1 rounded px-2 py-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground"
            >
              <ChevronRight
                className={cn(
                  'icon-sm transition-transform duration-200',
                  closedExpanded && 'rotate-90',
                )}
              />
              <span>
                {t('sidebar.closedProjects')} ({closedProjects.length})
              </span>
            </CollapsibleTrigger>
            <CollapsibleContent className="data-[state=open]:animate-slide-down">
              <div className="mt-1 flex flex-col gap-1.5">
                {closedProjects.map((project) => (
                  <ProjectItem
                    key={project.id}
                    project={project}
                    threads={EMPTY_THREADS}
                    threadsLoaded={false}
                    isExpanded={false}
                    isSelected={selectedProjectId === project.id}
                    onReopenProject={onReopenProject}
                    {...sharedHandlers}
                  />
                ))}
              </div>
            </CollapsibleContent>
          </Collapsible>
        )}
      </SidebarContent>
    </>
  );
}
