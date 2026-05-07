import { PanelLeft } from 'lucide-react';
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { ErrorBoundary } from '@/components/ErrorBoundary';
import { ResizeHandle, useResizeHandle } from '@/components/ui/resize-handle';
import { SidebarProvider, SidebarInset, useSidebar } from '@/components/ui/sidebar';
import { Toaster } from '@/components/ui/sonner';
import { WorkflowErrorModal } from '@/components/WorkflowErrorModal';
import { useGlobalShortcuts } from '@/hooks/use-global-shortcuts';
import { useRouteSync } from '@/hooks/use-route-sync';
import { useThreadHistoryTracker } from '@/hooks/use-thread-history-tracker';
import { useWS } from '@/hooks/use-ws';
import { cn } from '@/lib/utils';
import { TOAST_DURATION } from '@/lib/utils';
import { useAgentTemplateStore } from '@/stores/agent-template-store';
import { useInternalEditorStore } from '@/stores/internal-editor-store';
import { useProjectStore } from '@/stores/project-store';
import { ThreadProvider } from '@/stores/thread-context';
import { setAppNavigate, useThreadStore } from '@/stores/thread-store';
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
  const selectedThreadId = useThreadStore((s) => s.selectedThreadId);
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
    },
    onResize: (deltaPx) => {
      const deltaVw = (deltaPx / window.innerWidth) * 100;
      // Dragging the handle right shrinks the right pane
      setReviewPaneWidth(dragStartWidthVw.current - deltaVw);
    },
  });

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
      <ErrorBoundary area="sidebar">
        <Suspense fallback={<SidebarPlaceholder />}>
          <AppSidebar />
        </Suspense>
      </ErrorBoundary>
      <CollapsedSidebarStrip />

      <ThreadProvider threadId={selectedThreadId} source="active">
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

          {/* Right panel — Review / Tasks / Activity. Outer takes flex width so
              the center column compresses; inner is anchored to the right edge
              so the content visually slides in from the right as the outer
              expands (and slides out to the right when closing). */}
          {!isFullScreenView && (reviewPaneReady || reviewPaneOpen) && (
            <div
              className={cn(
                'relative min-w-0 flex-shrink-0 overflow-hidden bg-sidebar',
                !resizing && 'transition-[width] duration-200 ease-linear',
              )}
              style={{ width: rightPaneVisible ? `${reviewPaneWidth}vw` : '0vw' }}
            >
              <div
                className="absolute inset-y-0 right-0 flex"
                style={{ width: `${reviewPaneWidth}vw` }}
              >
                <div className="min-h-0 flex-1 overflow-hidden">
                  <ErrorBoundary area="right-pane">
                    <Suspense>
                      {rightPaneTab === 'review' ? (
                        <ReviewPane />
                      ) : rightPaneTab === 'files' ? (
                        <ProjectFilesPane />
                      ) : (
                        <ActivityPane />
                      )}
                    </Suspense>
                  </ErrorBoundary>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Global overlays — kept inside ThreadProvider so dialogs that read
          thread context (e.g. FileSearchDialog → useThreadWorktreePath) work. */}
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
      </ThreadProvider>
    </SidebarProvider>
  );
}
