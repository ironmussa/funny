import { PanelLeftOpen } from 'lucide-react';
import { useCallback, useRef, startTransition } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { Sidebar, useSidebar } from '@/components/ui/sidebar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useSidebarActions } from '@/hooks/use-sidebar-actions';
import { useSidebarDragDrop } from '@/hooks/use-sidebar-drag-drop';
import { useSidebarScrollSync } from '@/hooks/use-sidebar-scroll-sync';
import { useStableNavigate } from '@/hooks/use-stable-navigate';
import { useThreadsByProject } from '@/lib/thread-selectors';
import { buildPath } from '@/lib/url';
import { cn, scrollSidebarItemIntoView } from '@/lib/utils';
import { useProjectStore } from '@/stores/project-store';
import { useUIStore } from '@/stores/ui-store';

import { PreferencesPanelBody } from './PreferencesPanel';
import { SettingsPanelBody } from './SettingsPanel';
import { SidebarDialogs } from './sidebar/SidebarDialogs';
import { SidebarFooter } from './sidebar/SidebarFooter';
import { SidebarProjectsSection } from './sidebar/SidebarProjectsSection';
import { SidebarScratchSection } from './sidebar/SidebarScratchSection';
import { SidebarThreadsSection } from './sidebar/SidebarThreadsSection';
import { SidebarTopBar } from './sidebar/SidebarTopBar';

export function AppSidebar({ singleProjectId }: { singleProjectId?: string | null } = {}) {
  // Keep this wrapper's hook count stable (only `useSidebar`) so the collapse
  // toggle can early-return without violating the Rules of Hooks. All other
  // hooks live in `AppSidebarBody`, which only mounts in the expanded state.
  const { state: sidebarState } = useSidebar();
  if (sidebarState === 'collapsed') return <CollapsedSidebarRail />;
  return <AppSidebarBody singleProjectId={singleProjectId} />;
}

function AppSidebarBody({ singleProjectId }: { singleProjectId?: string | null }) {
  const navigate = useStableNavigate();
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
  const threadsByProject = useThreadsByProject();
  // ui-store
  const settingsOpen = useUIStore((s) => s.settingsOpen);
  const generalSettingsOpen = useUIStore((s) => s.generalSettingsOpen);
  const settingsNavOpen = settingsOpen || generalSettingsOpen;
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
    settingsNavOpen,
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
    <Sidebar collapsible="none" className="h-full w-full select-none">
      {/* Project settings nav — rendered alongside the projects tree so the
          tree stays mounted (avoiding a costly remount when returning). */}
      {settingsOpen && <SettingsPanelBody />}
      {generalSettingsOpen && <PreferencesPanelBody />}

      {/* Projects/threads tree — always mounted; hidden via display:none
          when settings nav is open so toggling is instant. Uses
          `display:contents` so the wrapper is layout-transparent inside
          the Sidebar's flex column. */}
      <div className={cn(settingsNavOpen ? 'hidden' : 'contents')}>
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

        <SidebarScratchSection
          onRenameThread={handleRenameThread}
          onDeleteThread={handleDeleteThreadFromList}
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

      {branchSwitchDialog}
    </Sidebar>
  );
}

/** Thin rail rendered when the sidebar is collapsed. Holds the expand button
 *  inside the sidebar's own column so the user can reopen it without going
 *  through the top bar. The dockview LEFT edge group is sized to match
 *  (`collapsedSize: 40` in DockviewLayout). */
function CollapsedSidebarRail() {
  const { t } = useTranslation();
  const { toggleSidebar } = useSidebar();
  return (
    <div className="border-sidebar-border bg-sidebar flex h-full w-full flex-col items-center border-r py-2">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            data-testid="sidebar-expand"
            variant="ghost"
            size="icon-sm"
            onClick={toggleSidebar}
            className="text-muted-foreground hover:text-foreground"
          >
            <PanelLeftOpen className="icon-base" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="right">{t('sidebar.show', 'Show sidebar')}</TooltipContent>
      </Tooltip>
    </div>
  );
}
