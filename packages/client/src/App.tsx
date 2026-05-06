import { PanelLeft } from 'lucide-react';
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import type { PanelImperativeHandle } from 'react-resizable-panels';
import { useNavigate } from 'react-router-dom';

import { ErrorBoundary } from '@/components/ErrorBoundary';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { SidebarProvider, SidebarInset, useSidebar } from '@/components/ui/sidebar';
import { Toaster } from '@/components/ui/sonner';
import { WorkflowErrorModal } from '@/components/WorkflowErrorModal';
import { useGlobalShortcuts } from '@/hooks/use-global-shortcuts';
import { useRouteSync } from '@/hooks/use-route-sync';
import { useThreadHistoryTracker } from '@/hooks/use-thread-history-tracker';
import { useWS } from '@/hooks/use-ws';
import { cn, TOAST_DURATION } from '@/lib/utils';
import { useAgentTemplateStore } from '@/stores/agent-template-store';
import { useInternalEditorStore } from '@/stores/internal-editor-store';
import { useProjectStore } from '@/stores/project-store';
import { useTerminalStore } from '@/stores/terminal-store';
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
  const loadTemplates = useAgentTemplateStore((s) => s.loadTemplates);
  const reviewPaneOpen = useUIStore((s) => s.reviewPaneOpen);
  const setReviewPaneOpen = useUIStore((s) => s.setReviewPaneOpen);
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

  // --- Terminal panel visibility (per-project) ---
  const selectedProjectId = useProjectStore((s) => s.selectedProjectId);
  const togglePanel = useTerminalStore((s) => s.togglePanel);
  const panelVisibleByProject = useTerminalStore((s) => s.panelVisibleByProject);
  const terminalPanelVisible = selectedProjectId
    ? (panelVisibleByProject[selectedProjectId] ?? false)
    : false;
  const showTerminalPanel = !(
    generalSettingsOpen ||
    settingsOpen ||
    analyticsOpen ||
    liveColumnsOpen ||
    testRunnerOpen ||
    automationInboxOpen ||
    addProjectOpen
  );

  // Imperative refs for the collapsible panels (right pane, terminal pane).
  const rightPanelRef = useRef<PanelImperativeHandle | null>(null);
  const terminalPanelRef = useRef<PanelImperativeHandle | null>(null);

  // Animation flags: true while a programmatic collapse/expand is in flight so
  // we can apply a CSS transition. We DON'T transition during drag — that would
  // make resizing feel laggy.
  const [rightAnimating, setRightAnimating] = useState(false);
  const [terminalAnimating, setTerminalAnimating] = useState(false);

  // Sync the right pane's collapsed state with the zustand store. Guard with
  // `isCollapsed()` to avoid an infinite loop with onResize → setReviewPaneOpen.
  // We use `resize()` instead of `expand()` because v4's expand() falls back to
  // minSize when the panel was collapsed before ever having a real size.
  useEffect(() => {
    const p = rightPanelRef.current;
    if (!p) return;
    const collapsed = p.isCollapsed();
    if (reviewPaneOpen && collapsed) {
      const prev = p.getSize().asPercentage;
      // flushSync ensures the transition className is applied to the DOM
      // BEFORE we mutate flex-grow — otherwise the change happens before the
      // transition exists and there's no animation.
      flushSync(() => setRightAnimating(true));
      p.resize(`${prev > 5 ? prev : 30}%`);
      const t = setTimeout(() => setRightAnimating(false), 260);
      return () => clearTimeout(t);
    } else if (!reviewPaneOpen && !collapsed) {
      flushSync(() => setRightAnimating(true));
      p.collapse();
      const t = setTimeout(() => setRightAnimating(false), 260);
      return () => clearTimeout(t);
    }
  }, [reviewPaneOpen, isFullScreenView]);

  // Sync the terminal pane's collapsed state with the per-project store.
  // Re-run on project change to reapply the stored visibility.
  useEffect(() => {
    const p = terminalPanelRef.current;
    if (!p) return;
    const collapsed = p.isCollapsed();
    if (terminalPanelVisible && collapsed) {
      const prev = p.getSize().asPercentage;
      flushSync(() => setTerminalAnimating(true));
      p.resize(`${prev > 5 ? prev : 30}%`);
      const t = setTimeout(() => setTerminalAnimating(false), 260);
      return () => clearTimeout(t);
    } else if (!terminalPanelVisible && !collapsed) {
      flushSync(() => setTerminalAnimating(true));
      p.collapse();
      const t = setTimeout(() => setTerminalAnimating(false), 260);
      return () => clearTimeout(t);
    }
  }, [terminalPanelVisible, selectedProjectId, showTerminalPanel]);

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

  // Handle right panel collapse/expand events from drag-induced layout changes.
  // The library has no onCollapse/onExpand callbacks (v4): we infer them from
  // onResize crossing the 0% boundary, then sync to the store. The
  // `isCollapsed()` guard above prevents the resulting store change from
  // looping back into another collapse/expand call.
  const onRightPaneResize = useCallback(
    (size: { asPercentage: number }) => {
      const isCollapsed = size.asPercentage <= 0.0001;
      if (isCollapsed && reviewPaneOpen) setReviewPaneOpen(false);
      else if (!isCollapsed && !reviewPaneOpen) setReviewPaneOpen(true);
    },
    [reviewPaneOpen, setReviewPaneOpen],
  );

  const onTerminalPaneResize = useCallback(
    (size: { asPercentage: number }) => {
      if (!selectedProjectId) return;
      const isCollapsed = size.asPercentage <= 0.0001;
      const currentVisible =
        useTerminalStore.getState().panelVisibleByProject[selectedProjectId] ?? false;
      if (isCollapsed && currentVisible) togglePanel(selectedProjectId);
      else if (!isCollapsed && !currentVisible) togglePanel(selectedProjectId);
    },
    [selectedProjectId, togglePanel],
  );

  // Build the main content node — used in both the panel-group branch and the
  // full-screen branch.
  const mainContent = (
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
  );

  return (
    <SidebarProvider defaultOpen={true} className="h-screen overflow-hidden">
      <ErrorBoundary area="sidebar">
        <Suspense fallback={<SidebarPlaceholder />}>
          <AppSidebar />
        </Suspense>
      </ErrorBoundary>
      <CollapsedSidebarStrip />

      {isFullScreenView ? (
        <div className="flex min-h-0 flex-1 overflow-hidden" data-testid="main-panel-group">
          <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
            <SidebarInset className="flex h-full flex-col overflow-hidden">
              <div className="flex min-h-0 flex-1 overflow-hidden">{mainContent}</div>
            </SidebarInset>
          </div>
        </div>
      ) : (
        <ResizablePanelGroup
          id="funny:main-h"
          orientation="horizontal"
          className="min-h-0 flex-1 overflow-hidden"
          data-testid="main-panel-group"
        >
          <ResizablePanel id="center" defaultSize={70} minSize={15}>
            <ResizablePanelGroup
              id="funny:center-v"
              orientation="vertical"
              className="h-full w-full"
            >
              <ResizablePanel id="content" defaultSize={70} minSize={20}>
                <SidebarInset className="flex h-full flex-col overflow-hidden">
                  <div className="flex min-h-0 flex-1 overflow-hidden">{mainContent}</div>
                </SidebarInset>
              </ResizablePanel>
              {showTerminalPanel && <ResizableHandle id="terminal-resize-handle" />}
              {showTerminalPanel && (
                <ResizablePanel
                  id="terminal"
                  defaultSize={30}
                  minSize={10}
                  collapsible
                  collapsedSize={0}
                  panelRef={terminalPanelRef}
                  onResize={onTerminalPaneResize}
                  className={
                    terminalAnimating
                      ? 'transition-[flex-grow] duration-[250ms] ease-out'
                      : undefined
                  }
                >
                  <Suspense>
                    <TerminalPanel />
                  </Suspense>
                </ResizablePanel>
              )}
            </ResizablePanelGroup>
          </ResizablePanel>

          <ResizableHandle id="right-pane-resize-handle" />

          <ResizablePanel
            id="right"
            defaultSize={30}
            minSize={15}
            collapsible
            collapsedSize={0}
            panelRef={rightPanelRef}
            onResize={onRightPaneResize}
            className={cn(
              'bg-sidebar',
              rightAnimating && 'transition-[flex-grow] duration-[250ms] ease-out',
            )}
          >
            <div className="flex h-full min-h-0 flex-col overflow-hidden">
              <div className="min-h-0 flex-1 overflow-hidden">
                <ErrorBoundary area="right-pane">
                  <Suspense>
                    {rightPaneTab === 'review' ? <ReviewPane /> : <ActivityPane />}
                  </Suspense>
                </ErrorBoundary>
              </div>
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
      )}

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
