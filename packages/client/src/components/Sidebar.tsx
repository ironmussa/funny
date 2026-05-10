import { useCallback, useRef, startTransition } from 'react';

import { Sidebar, SidebarRail, useSidebar } from '@/components/ui/sidebar';
import { useSidebarActions } from '@/hooks/use-sidebar-actions';
import { useSidebarDragDrop } from '@/hooks/use-sidebar-drag-drop';
import { useSidebarScrollSync } from '@/hooks/use-sidebar-scroll-sync';
import { useStableNavigate } from '@/hooks/use-stable-navigate';
import { buildPath } from '@/lib/url';
import { cn, scrollSidebarItemIntoView } from '@/lib/utils';
import { useProjectStore } from '@/stores/project-store';
import { useThreadStore } from '@/stores/thread-store';
import { useUIStore } from '@/stores/ui-store';

import { SettingsPanelBody } from './SettingsPanel';
import { SidebarDialogs } from './sidebar/SidebarDialogs';
import { SidebarFooter } from './sidebar/SidebarFooter';
import { SidebarProjectsSection } from './sidebar/SidebarProjectsSection';
import { SidebarThreadsSection } from './sidebar/SidebarThreadsSection';
import { SidebarTopBar } from './sidebar/SidebarTopBar';

export function AppSidebar({ singleProjectId }: { singleProjectId?: string | null } = {}) {
  const navigate = useStableNavigate();
  useSidebar();
  // project-store
  const allProjects = useProjectStore((s) => s.projects);
  const projects = singleProjectId
    ? allProjects.filter((p) => p.id === singleProjectId)
    : allProjects;
  const projectsInitialized = useProjectStore((s) => s.initialized);
  const selectedProjectId = useProjectStore((s) => s.selectedProjectId);
  const expandedProjects = useProjectStore((s) => s.expandedProjects);
  const toggleProject = useProjectStore((s) => s.toggleProject);
  const reorderProjects = useProjectStore((s) => s.reorderProjects);
  // thread-store
  const threadsByProject = useThreadStore((s) => s.threadsByProject);
  // ui-store
  const settingsOpen = useUIStore((s) => s.settingsOpen);
  const startNewThread = useUIStore((s) => s.startNewThread);
  const showGlobalSearch = useUIStore((s) => s.showGlobalSearch);

  const actions = useSidebarActions();
  const {
    archiveConfirm,
    setArchiveConfirm,
    deleteThreadConfirm,
    setDeleteThreadConfirm,
    renameProjectState,
    setRenameProjectState,
    deleteProjectConfirm,
    setDeleteProjectConfirm,
    actionLoading,
    issuesProjectId,
    setIssuesProjectId,
    handleArchiveConfirm,
    handleDeleteThreadConfirm,
    handleRenameProjectConfirm,
    handleDeleteProjectConfirm,
    handleSelectThread,
    handleArchiveThread,
    handleArchiveThreadFromList,
    handleRenameThread,
    handlePinThread,
    handleDeleteThread,
    handleDeleteThreadFromList,
    handleRenameProject,
    handleDeleteProject,
    handleCloseProject,
    handleReopenProject,
    handleShowIssues,
    branchSwitchDialog,
  } = actions;

  const projectsScrollRef = useRef<HTMLDivElement>(null);
  const threadsScrollRef = useRef<HTMLDivElement>(null);
  const threadsTopSentinelRef = useRef<HTMLDivElement>(null);
  const projectsTopSentinelRef = useRef<HTMLDivElement>(null);

  useSidebarScrollSync({
    selectedProjectId,
    projectsScrollRef,
    settingsOpen,
  });
  useSidebarDragDrop({ projectsScrollRef, threadsScrollRef, projects, reorderProjects });

  const handleToggleProject = useCallback(
    (projectId: string) => {
      toggleProject(projectId);
    },
    [toggleProject],
  );

  const handleSelectProject = useCallback(
    (projectId: string) => {
      startTransition(() => {
        useProjectStore.getState().selectProject(projectId);
        useUIStore.getState().setReviewPaneOpen(false);
        navigate(buildPath(`/projects/${projectId}`));
      });
      requestAnimationFrame(() => {
        const root = projectsScrollRef.current;
        const el = root?.querySelector(`[data-project-id="${projectId}"]`);
        if (root && el) scrollSidebarItemIntoView(root, el, 'nearest');
        const ta = document.querySelector<HTMLElement>('[data-testid="prompt-editor"]');
        ta?.focus();
      });
    },
    [navigate],
  );

  const handleNewThread = useCallback(
    (projectId: string) => {
      startTransition(() => {
        startNewThread(projectId);
        navigate(buildPath(`/projects/${projectId}`));
      });
    },
    [startNewThread, navigate],
  );

  const handleShowAllThreads = useCallback(
    (projectId: string) => {
      showGlobalSearch();
      navigate(buildPath(`/list?project=${projectId}`));
    },
    [showGlobalSearch, navigate],
  );

  return (
    <Sidebar collapsible="offcanvas" className="select-none">
      {/* Project settings nav — rendered alongside the projects tree so the
          tree stays mounted (avoiding a costly remount when returning). */}
      {settingsOpen && <SettingsPanelBody />}

      {/* Projects/threads tree — always mounted; hidden via display:none
          when project settings is open so toggling is instant. Uses
          `display:contents` so the wrapper is layout-transparent inside
          the Sidebar's flex column. */}
      <div className={cn(settingsOpen ? 'hidden' : 'contents')}>
        <SidebarTopBar />

        <SidebarThreadsSection
          scrollRef={threadsScrollRef}
          topSentinelRef={threadsTopSentinelRef}
          onRenameThread={handleRenameThread}
          onArchiveThread={handleArchiveThreadFromList}
          onDeleteThread={handleDeleteThreadFromList}
        />

        <SidebarProjectsSection
          projects={projects}
          projectsInitialized={projectsInitialized}
          selectedProjectId={selectedProjectId}
          expandedProjects={expandedProjects}
          threadsByProject={threadsByProject}
          scrollRef={projectsScrollRef}
          topSentinelRef={projectsTopSentinelRef}
          onToggle={handleToggleProject}
          onSelectProject={handleSelectProject}
          onNewThread={handleNewThread}
          onRenameProject={handleRenameProject}
          onDeleteProject={handleDeleteProject}
          onCloseProject={handleCloseProject}
          onReopenProject={handleReopenProject}
          onSelectThread={handleSelectThread}
          onRenameThread={handleRenameThread}
          onArchiveThread={handleArchiveThread}
          onPinThread={handlePinThread}
          onDeleteThread={handleDeleteThread}
          onShowAllThreads={handleShowAllThreads}
          onShowIssues={handleShowIssues}
        />

        <SidebarFooter />
      </div>

      <SidebarDialogs
        archiveConfirm={archiveConfirm}
        setArchiveConfirm={setArchiveConfirm}
        handleArchiveConfirm={handleArchiveConfirm}
        deleteThreadConfirm={deleteThreadConfirm}
        setDeleteThreadConfirm={setDeleteThreadConfirm}
        handleDeleteThreadConfirm={handleDeleteThreadConfirm}
        renameProjectState={renameProjectState}
        setRenameProjectState={setRenameProjectState}
        handleRenameProjectConfirm={handleRenameProjectConfirm}
        deleteProjectConfirm={deleteProjectConfirm}
        setDeleteProjectConfirm={setDeleteProjectConfirm}
        handleDeleteProjectConfirm={handleDeleteProjectConfirm}
        issuesProjectId={issuesProjectId}
        setIssuesProjectId={setIssuesProjectId}
        actionLoading={actionLoading}
      />

      <SidebarRail />

      {branchSwitchDialog}
    </Sidebar>
  );
}
