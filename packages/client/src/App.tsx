import { PanelLeft } from 'lucide-react';
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import type { PanelImperativeHandle } from 'react-resizable-panels';
import { useNavigate } from 'react-router-dom';

import { ErrorBoundary } from '@/components/ErrorBoundary';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { SidebarProvider, SidebarInset, useSidebar } from '@/components/ui/sidebar';
import { Toaster } from '@/components/ui/sonner';
import { WorkflowErrorModal } from '@/components/WorkflowErrorModal';
import { useGlobalShortcuts } from '@/hooks/use-global-shortcuts';
import { useRouteSync } from '@/hooks/use-route-sync';
import { useWS } from '@/hooks/use-ws';
import { TOAST_DURATION } from '@/lib/utils';
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
    <button
      onClick={toggleSidebar}
      className="flex h-full w-10 flex-shrink-0 cursor-pointer items-start justify-center border-r border-border bg-sidebar pt-3 transition-colors hover:bg-sidebar-accent"
      title="Expand sidebar"
    >
      <PanelLeft className="icon-base text-muted-foreground" />
    </button>
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
  const reviewPaneOpen = useUIStore((s) => s.reviewPaneOpen);
  const reviewPaneWidth = useUIStore((s) => s.reviewPaneWidth);
  const setReviewPaneWidth = useUIStore((s) => s.setReviewPaneWidth);
  const rightPaneTab = useUIStore((s) => s.rightPaneTab);
  const settingsOpen = useUIStore((s) => s.settingsOpen);
  const generalSettingsOpen = useUIStore((s) => s.generalSettingsOpen);
  const allThreadsProjectId = useUIStore((s) => s.allThreadsProjectId);
  const automationInboxOpen = useUIStore((s) => s.automationInboxOpen);
  const addProjectOpen = useUIStore((s) => s.addProjectOpen);
  const analyticsOpen = useUIStore((s) => s.analyticsOpen);
  const liveColumnsOpen = useUIStore((s) => s.liveColumnsOpen);
  const testRunnerOpen = useUIStore((s) => s.testRunnerOpen);
  const internalEditorOpen = useInternalEditorStore((s) => s.isOpen);
  const internalEditorFilePath = useInternalEditorStore((s) => s.filePath);
  const internalEditorContent = useInternalEditorStore((s) => s.initialContent);
  const navigate = useNavigate();
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [fileSearchOpen, setFileSearchOpen] = useState(false);

  // --- Right panel (ResizablePanelGroup) ---
  const rightPanelRef = useRef<PanelImperativeHandle>(null);
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

  // Sync panel collapse/expand with store
  useEffect(() => {
    const panel = rightPanelRef.current;
    if (!panel || isFullScreenView) return;
    try {
      if (rightPaneVisible) {
        if (panel.isCollapsed()) panel.expand();
      } else {
        if (!panel.isCollapsed()) panel.collapse();
      }
    } catch {
      // Panel may not be registered with PanelGroup yet after re-mount
    }
  }, [rightPaneVisible, isFullScreenView]);

  // Persist right panel size to store (convert px → vw) and detect collapse/expand
  const handleRightPanelResize = useCallback(
    (size: { asPercentage: number; inPixels: number }) => {
      const state = useUIStore.getState();
      if (size.inPixels === 0) {
        // Panel collapsed — sync store
        if (state.reviewPaneOpen) state.setReviewPaneOpen(false);
        return;
      }
      // Panel expanded — sync store
      if (!state.reviewPaneOpen) state.setReviewPaneOpen(true);
      const vw = (size.inPixels / window.innerWidth) * 100;
      setReviewPaneWidth(vw);
    },
    [setReviewPaneWidth],
  );

  // Eagerly mount ReviewPane (hidden) after initial load so first toggle is instant.
  // Deferred via requestIdleCallback to avoid blocking the initial render.
  const [reviewPaneReady, setReviewPaneReady] = useState(false);
  useEffect(() => {
    const mount = () => setReviewPaneReady(true);
    if (typeof requestIdleCallback === 'function') {
      const id = requestIdleCallback(mount);
      return () => cancelIdleCallback(id);
    } else {
      const id = setTimeout(mount, 3000);
      return () => clearTimeout(id);
    }
  }, []);

  // Register navigate so the store can trigger navigation (e.g. from toasts)
  useEffect(() => {
    setAppNavigate(navigate);
  }, [navigate]);

  // Connect WebSocket on mount
  useWS();

  // Sync URL ↔ store
  useRouteSync();

  // Load projects on mount (auth already initialized by AuthGate)
  useEffect(() => {
    loadProjects();
  }, [loadProjects]);

  // Global keyboard shortcuts (extracted to dedicated hook)
  const toggleCommandPalette = useCallback(() => {
    setCommandPaletteOpen((prev) => !prev);
  }, []);
  const toggleFileSearch = useCallback(() => {
    setFileSearchOpen((prev) => !prev);
  }, []);
  useGlobalShortcuts(toggleCommandPalette, toggleFileSearch);

  return (
    <SidebarProvider defaultOpen={true} className="h-screen overflow-hidden">
      <ErrorBoundary area="sidebar">
        <Suspense fallback={<SidebarPlaceholder />}>
          <AppSidebar />
        </Suspense>
      </ErrorBoundary>
      <CollapsedSidebarStrip />

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <ResizablePanelGroup orientation="horizontal" data-testid="main-panel-group">
          {/* Center panel — main content + terminal */}
          <ResizablePanel
            minSize="30%"
            className="flex flex-col"
            style={{ overflow: 'hidden', minWidth: 0 }}
          >
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
          </ResizablePanel>

          {/* Resize handle between center and right pane — hidden during full-screen views */}
          {!isFullScreenView && <ResizableHandle data-testid="right-pane-resize-handle" />}

          {/* Right panel — Review / Tests / Activity / Tasks — unmounted during full-screen views */}
          {!isFullScreenView && (
            <ResizablePanel
              panelRef={rightPanelRef}
              defaultSize={`${reviewPaneWidth}vw`}
              minSize="250px"
              maxSize="70vw"
              collapsible
              collapsedSize="0px"
              onResize={handleRightPanelResize}
              className="flex flex-col"
              style={{ overflow: 'hidden', minWidth: 0 }}
            >
              {(reviewPaneReady || reviewPaneOpen) && (
                <div className="flex h-full min-w-0 flex-1 flex-col bg-sidebar">
                  <div className="min-h-0 flex-1 overflow-hidden">
                    <ErrorBoundary area="right-pane">
                      <Suspense>
                        {rightPaneTab === 'review' ? (
                          <ReviewPane />
                        ) : rightPaneTab === 'tasks' ? (
                          <TasksPane />
                        ) : (
                          <ActivityPane />
                        )}
                      </Suspense>
                    </ErrorBoundary>
                  </div>
                </div>
              )}
            </ResizablePanel>
          )}
        </ResizablePanelGroup>
      </div>

      <Toaster position="bottom-right" duration={TOAST_DURATION} />
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
