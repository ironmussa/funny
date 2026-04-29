import { PanelLeft } from 'lucide-react';
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { ErrorBoundary } from '@/components/ErrorBoundary';
import { ResizeHandle, useResizeHandle } from '@/components/ui/resize-handle';
import { SidebarProvider, SidebarInset, useSidebar } from '@/components/ui/sidebar';
import { Toaster } from '@/components/ui/sonner';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { WorkflowErrorModal } from '@/components/WorkflowErrorModal';
import { useActiveThreadBranchSync } from '@/hooks/use-active-thread-branch-sync';
import { useGlobalShortcuts } from '@/hooks/use-global-shortcuts';
import { useRefreshOnFocus } from '@/hooks/use-refresh-on-focus';
import { useRouteSync } from '@/hooks/use-route-sync';
import { useThreadHistoryTracker } from '@/hooks/use-thread-history-tracker';
import { useWS } from '@/hooks/use-ws';
import { cn, TOAST_DURATION } from '@/lib/utils';
import { useAgentTemplateStore } from '@/stores/agent-template-store';
import { useInternalEditorStore } from '@/stores/internal-editor-store';
import { useProjectStore } from '@/stores/project-store';
import { setAppNavigate } from '@/stores/thread-store';
import { useUIStore } from '@/stores/ui-store';

const AppSidebar = lazy(() =>
  import('@/components/Sidebar').then((m) => ({ default: m.AppSidebar })),
);
// Prefetch ThreadView immediately — it's the primary view users always see.
// This fires the chunk download in parallel with auth bootstrap.
const threadViewImport = import('@/components/ThreadView').then((m) => ({ default: m.ThreadView }));
const ThreadView = lazy(() => threadViewImport);

const SIDEBAR_WIDTH_STORAGE_KEY = 'sidebar_width';
const DEFAULT_SIDEBAR_WIDTH = 320;

/** Placeholder matching the persisted sidebar width to avoid CLS during lazy load */
function SidebarPlaceholder() {
  let w = DEFAULT_SIDEBAR_WIDTH;
  try {
    const s = localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY);
    if (s) w = Number(s);
  } catch {}
  return (
    <div style={{ width: w }} className="flex-shrink-0 border-r border-sidebar-border bg-sidebar" />
  );
}

/** Thin vertical strip visible when the sidebar is collapsed, click to reopen */
function CollapsedSidebarStrip() {
  const { state, toggleSidebar } = useSidebar();
  if (state === 'expanded') return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          onClick={toggleSidebar}
          className="flex h-full w-10 flex-shrink-0 cursor-pointer items-start justify-center border-r border-border bg-sidebar pt-3 transition-colors hover:bg-sidebar-accent"
          aria-label="Expand sidebar"
        >
          <PanelLeft className="icon-base text-muted-foreground" />
        </button>
      </TooltipTrigger>
      <TooltipContent>Expand sidebar</TooltipContent>
    </Tooltip>
  );
}

// Lazy-load conditional views (bundle-conditional / bundle-dynamic-imports)
const AllThreadsView = lazy(() =>
  import('@/components/AllThreadsView').then((m) => ({ default: m.AllThreadsView })),
);
const reviewPaneImport = () =>
  import('@/components/ReviewPane').then((m) => ({ default: m.ReviewPane }));
const ReviewPane = lazy(reviewPaneImport);
const TestRunnerPane = lazy(() =>
  import('@/components/TestRunnerPane').then((m) => ({ default: m.TestRunnerPane })),
);
const TasksPane = lazy(() =>
  import('@/components/sidebar/TasksPanel').then((m) => ({ default: m.TasksPanel })),
);
const ActivityPane = lazy(() =>
  import('@/components/ActivityPane').then((m) => ({ default: m.ActivityPane })),
);
const ProjectFilesPane = lazy(() =>
  import('@/components/ProjectFilesPane').then((m) => ({ default: m.ProjectFilesPane })),
);
const TerminalPanel = lazy(() =>
  import('@/components/TerminalPanel').then((m) => ({ default: m.TerminalPanel })),
);
const SettingsDetailView = lazy(() =>
  import('@/components/SettingsDetailView').then((m) => ({ default: m.SettingsDetailView })),
);
const GeneralSettingsView = lazy(() =>
  import('@/components/GeneralSettingsView').then((m) => ({ default: m.GeneralSettingsView })),
);
const AutomationInboxView = lazy(() =>
  import('@/components/AutomationInboxView').then((m) => ({ default: m.AutomationInboxView })),
);
const AddProjectView = lazy(() =>
  import('@/components/AddProjectView').then((m) => ({ default: m.AddProjectView })),
);
const AnalyticsView = lazy(() =>
  import('@/components/AnalyticsView').then((m) => ({ default: m.AnalyticsView })),
);
const LiveColumnsView = lazy(() =>
  import('@/components/LiveColumnsView').then((m) => ({ default: m.LiveColumnsView })),
);
const commandPaletteImport = () =>
  import('@/components/CommandPalette').then((m) => ({ default: m.CommandPalette }));
const CommandPalette = lazy(commandPaletteImport);
const fileSearchImport = () =>
  import('@/components/FileSearchDialog').then((m) => ({ default: m.FileSearchDialog }));
const FileSearchDialog = lazy(fileSearchImport);
// Prefetch the CommandPalette and ReviewPane chunks on idle so they open instantly
if (typeof requestIdleCallback === 'function') {
  requestIdleCallback(() => {
    commandPaletteImport();
  });
  requestIdleCallback(() => {
    fileSearchImport();
  });
  requestIdleCallback(() => {
    reviewPaneImport();
  });
} else {
  setTimeout(() => {
    commandPaletteImport();
  }, 2000);
  setTimeout(() => {
    fileSearchImport();
  }, 2500);
  setTimeout(() => {
    reviewPaneImport();
  }, 3000);
}
const CircuitBreakerDialog = lazy(() =>
  import('@/components/CircuitBreakerDialog').then((m) => ({ default: m.CircuitBreakerDialog })),
);
const MonacoEditorDialog = lazy(() =>
  import('@/components/MonacoEditorDialog').then((m) => ({ default: m.MonacoEditorDialog })),
);

export function App() {
  const loadProjects = useProjectStore((s) => s.loadProjects);
  const loadTemplates = useAgentTemplateStore((s) => s.loadTemplates);
  const reviewPaneOpen = useUIStore((s) => s.reviewPaneOpen);
  const reviewPaneWidth = useUIStore((s) => s.reviewPaneWidth);
  const setReviewPaneWidth = useUIStore((s) => s.setReviewPaneWidth);
  const reviewPaneResizing = useUIStore((s) => s.reviewPaneResizing);
  const setReviewPaneResizing = useUIStore((s) => s.setReviewPaneResizing);
  const rightPaneTab = useUIStore((s) => s.rightPaneTab);
  const settingsOpen = useUIStore((s) => s.settingsOpen);
  const generalSettingsOpen = useUIStore((s) => s.generalSettingsOpen);
  const allThreadsProjectId = useUIStore((s) => s.allThreadsProjectId);
  const automationInboxOpen = useUIStore((s) => s.automationInboxOpen);
  const addProjectOpen = useUIStore((s) => s.addProjectOpen);
  const analyticsOpen = useUIStore((s) => s.analyticsOpen);
  const liveColumnsOpen = useUIStore((s) => s.liveColumnsOpen);
  const designViewDesignId = useUIStore((s) => s.designViewDesignId);
  const designViewOpen = !!designViewDesignId;
  const testRunnerOpen = useUIStore((s) => s.testRunnerOpen);
  const internalEditorOpen = useInternalEditorStore((s) => s.isOpen);
  const internalEditorFilePath = useInternalEditorStore((s) => s.filePath);
  const internalEditorContent = useInternalEditorStore((s) => s.initialContent);
  const navigate = useNavigate();
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [fileSearchOpen, setFileSearchOpen] = useState(false);

  // --- Right panel layout ---
  const isFullScreenView =
    settingsOpen ||
    generalSettingsOpen ||
    analyticsOpen ||
    liveColumnsOpen ||
    testRunnerOpen ||
    automationInboxOpen ||
    addProjectOpen ||
    !!allThreadsProjectId;
  const rightPaneVisible = reviewPaneOpen && !isFullScreenView;

  // Drag-to-resize for the right pane. Capture starting width on pointerdown
  // so the first drag responds immediately (no unit-normalization snap).
  const dragStartWidthVw = useRef(0);
  const { resizing, handlePointerDown, handlePointerMove, handlePointerUp } = useResizeHandle({
    direction: 'horizontal',
    onResizeStart: () => {
      dragStartWidthVw.current = useUIStore.getState().reviewPaneWidth;
      setReviewPaneResizing(true);
    },
    onResize: (deltaPx) => {
      const deltaVw = (deltaPx / window.innerWidth) * 100;
      // Dragging the handle right shrinks the right pane
      setReviewPaneWidth(dragStartWidthVw.current - deltaVw);
    },
    onResizeEnd: () => {
      setReviewPaneResizing(false);
    },
  });

  // Register navigate so the store can trigger navigation (e.g. from toasts)
  useEffect(() => {
    setAppNavigate(navigate);
  }, [navigate]);

  // Connect WebSocket on mount
  useWS();

  // Refresh git state when the tab/window regains focus (catches external commits)
  useRefreshOnFocus();

  // Sync URL ↔ store
  useRouteSync();

  // Keep working dir branch aligned with the active local thread (covers
  // deep-linked / new-tab loads that bypass the sidebar's preflight).
  const branchSyncDialog = useActiveThreadBranchSync();

  // Load projects and agent templates on mount (auth already initialized by AuthGate)
  useEffect(() => {
    loadProjects();
    loadTemplates();
  }, [loadProjects, loadTemplates]);

  // Update browser tab title with selected project name
  const selectedProjectId = useProjectStore((s) => s.selectedProjectId);
  const selectedProjectName = useProjectStore(
    (s) => s.projects.find((p) => p.id === s.selectedProjectId)?.name,
  );
  const selectedProjectBranch = useProjectStore((s) =>
    s.selectedProjectId ? s.branchByProject[s.selectedProjectId] : undefined,
  );
  useEffect(() => {
    if (selectedProjectName && selectedProjectBranch) {
      document.title = `${selectedProjectName} [${selectedProjectBranch}] — funny`;
    } else if (selectedProjectName) {
      document.title = `${selectedProjectName} — funny`;
    } else {
      document.title = 'funny';
    }
  }, [selectedProjectId, selectedProjectName, selectedProjectBranch]);

  // Global keyboard shortcuts (extracted to dedicated hook)
  const toggleCommandPalette = useCallback(() => {
    setCommandPaletteOpen((prev) => !prev);
  }, []);
  const toggleFileSearch = useCallback(() => {
    setFileSearchOpen((prev) => !prev);
  }, []);
  useGlobalShortcuts(toggleCommandPalette, toggleFileSearch);
  useThreadHistoryTracker();

  return (
    <SidebarProvider defaultOpen={true} className="h-screen overflow-hidden">
      {!designViewOpen && (
        <ErrorBoundary area="sidebar">
          <Suspense fallback={<SidebarPlaceholder />}>
            <AppSidebar />
          </Suspense>
        </ErrorBoundary>
      )}
      {!designViewOpen && <CollapsedSidebarStrip />}

      <div className="flex min-h-0 flex-1 overflow-hidden" data-testid="main-panel-group">
        {/* Center panel — main content + terminal */}
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <SidebarInset className="flex h-full flex-col overflow-hidden">
            <div className="flex min-h-0 flex-1 overflow-hidden">
              <ErrorBoundary area="main-content">
                <Suspense>
                  {generalSettingsOpen ? (
                    <GeneralSettingsView />
                  ) : settingsOpen ? (
                    <SettingsDetailView />
                  ) : analyticsOpen ? (
                    <AnalyticsView />
                  ) : liveColumnsOpen ? (
                    <LiveColumnsView />
                  ) : testRunnerOpen ? (
                    <TestRunnerPane />
                  ) : automationInboxOpen ? (
                    <AutomationInboxView />
                  ) : addProjectOpen ? (
                    <AddProjectView />
                  ) : allThreadsProjectId ? (
                    <AllThreadsView />
                  ) : (
                    <ThreadView />
                  )}
                </Suspense>
              </ErrorBoundary>
            </div>

            <Suspense>
              {!(
                generalSettingsOpen ||
                settingsOpen ||
                analyticsOpen ||
                liveColumnsOpen ||
                testRunnerOpen ||
                automationInboxOpen ||
                addProjectOpen
              ) && <TerminalPanel />}
            </Suspense>
          </SidebarInset>
        </div>

        {/* Resize handle between center and right pane — only when right pane is shown */}
        {rightPaneVisible && (
          <ResizeHandle
            direction="horizontal"
            resizing={resizing}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            data-testid="right-pane-resize-handle"
          />
        )}

        {/* Right panel — Review / Tasks / Activity. Wrapper stays mounted so
            width can animate open/closed; inner content unmounts when hidden. */}
        <div
          className={cn(
            'flex min-w-0 flex-shrink-0 flex-col overflow-hidden bg-sidebar',
            !resizing && !reviewPaneResizing && 'transition-[width] duration-200 ease-linear',
          )}
          style={{ width: rightPaneVisible ? `${reviewPaneWidth}vw` : 0 }}
        >
          {rightPaneVisible && (
            <div
              className="min-h-0 flex-1 overflow-hidden"
              style={{ width: `${reviewPaneWidth}vw` }}
            >
              <ErrorBoundary area="right-pane">
                <Suspense>
                  {rightPaneTab === 'review' ? (
                    <ReviewPane />
                  ) : rightPaneTab === 'tasks' ? (
                    <TasksPane />
                  ) : rightPaneTab === 'files' ? (
                    <ProjectFilesPane />
                  ) : (
                    <ActivityPane />
                  )}
                </Suspense>
              </ErrorBoundary>
            </div>
          )}
        </div>
      </div>

      <Toaster position="bottom-right" duration={TOAST_DURATION} />
      {branchSyncDialog}
      <WorkflowErrorModal />
      <Suspense>
        <CircuitBreakerDialog />
      </Suspense>
      <Suspense>
        <CommandPalette open={commandPaletteOpen} onOpenChange={setCommandPaletteOpen} />
      </Suspense>
      <Suspense>
        <FileSearchDialog open={fileSearchOpen} onOpenChange={setFileSearchOpen} />
      </Suspense>

      {/* Internal Monaco Editor Dialog (global, lazy-loaded) */}
      <Suspense>
        <MonacoEditorDialog
          open={internalEditorOpen}
          onOpenChange={(open) => {
            if (!open) useInternalEditorStore.getState().closeEditor();
          }}
          filePath={internalEditorFilePath || ''}
          initialContent={internalEditorContent}
        />
      </Suspense>
    </SidebarProvider>
  );
}
