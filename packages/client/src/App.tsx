import { PanelLeft } from 'lucide-react';
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { ResizeHandle, useResizeHandle } from '@/components/ui/resize-handle';
import { SidebarProvider, SidebarInset, useSidebar } from '@/components/ui/sidebar';
import { Toaster } from '@/components/ui/sonner';
import { useGlobalShortcuts } from '@/hooks/use-global-shortcuts';
import { useRouteSync } from '@/hooks/use-route-sync';
import { useWS } from '@/hooks/use-ws';
import { cn } from '@/lib/utils';
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
      <PanelLeft className="h-4 w-4 text-muted-foreground" />
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
// Prefetch the CommandPalette and ReviewPane chunks on idle so they open instantly
if (typeof requestIdleCallback === 'function') {
  requestIdleCallback(() => {
    commandPaletteImport();
  });
  requestIdleCallback(() => {
    reviewPaneImport();
  });
} else {
  setTimeout(() => {
    commandPaletteImport();
  }, 2000);
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
  const testPaneWidth = useUIStore((s) => s.testPaneWidth);
  const setReviewPaneWidth = useUIStore((s) => s.setReviewPaneWidth);
  const setTestPaneWidth = useUIStore((s) => s.setTestPaneWidth);
  const rightPaneTab = useUIStore((s) => s.rightPaneTab);
  const activeWidth = rightPaneTab === 'tests' ? testPaneWidth : reviewPaneWidth;
  const settingsOpen = useUIStore((s) => s.settingsOpen);
  const generalSettingsOpen = useUIStore((s) => s.generalSettingsOpen);
  const allThreadsProjectId = useUIStore((s) => s.allThreadsProjectId);
  const automationInboxOpen = useUIStore((s) => s.automationInboxOpen);
  const addProjectOpen = useUIStore((s) => s.addProjectOpen);
  const analyticsOpen = useUIStore((s) => s.analyticsOpen);
  const liveColumnsOpen = useUIStore((s) => s.liveColumnsOpen);
  const internalEditorOpen = useInternalEditorStore((s) => s.isOpen);
  const internalEditorFilePath = useInternalEditorStore((s) => s.filePath);
  const internalEditorContent = useInternalEditorStore((s) => s.initialContent);
  const navigate = useNavigate();
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  // --- Right sidebar resize handle ---
  const rpStartWidth = useRef(0);
  // Track which setter to use during a drag (captured at pointer-down)
  const rpActiveSetWidth = useRef<(w: number) => void>(setReviewPaneWidth);

  const {
    resizing: rpResizing,
    handlePointerDown: handleRpPointerDown,
    handlePointerMove: handleRpPointerMove,
    handlePointerUp: handleRpPointerUp,
  } = useResizeHandle({
    direction: 'horizontal',
    onResizeStart: () => {
      const state = useUIStore.getState();
      const isTests = state.rightPaneTab === 'tests';
      rpStartWidth.current = isTests ? state.testPaneWidth : state.reviewPaneWidth;
      rpActiveSetWidth.current = isTests ? setTestPaneWidth : setReviewPaneWidth;
    },
    onResize: (deltaPx) => {
      // Dragging left increases width, dragging right decreases
      const deltaVw = (-deltaPx / window.innerWidth) * 100;
      rpActiveSetWidth.current(rpStartWidth.current + deltaVw);
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

  // Load projects on mount (auth already initialized by AuthGate)
  useEffect(() => {
    loadProjects();
  }, [loadProjects]);

  // Global keyboard shortcuts (extracted to dedicated hook)
  const toggleCommandPalette = useCallback(() => {
    setCommandPaletteOpen((prev) => !prev);
  }, []);
  useGlobalShortcuts(toggleCommandPalette);

  return (
    <SidebarProvider defaultOpen={true} className="h-screen overflow-hidden">
      <Suspense fallback={<SidebarPlaceholder />}>
        <AppSidebar />
      </Suspense>
      <CollapsedSidebarStrip />

      <SidebarInset className="flex flex-col overflow-hidden">
        {/* Main content + terminal */}
        <div className="flex min-h-0 flex-1 overflow-hidden">
          <Suspense>
            {generalSettingsOpen ? (
              <GeneralSettingsView />
            ) : settingsOpen ? (
              <SettingsDetailView />
            ) : analyticsOpen ? (
              <AnalyticsView />
            ) : liveColumnsOpen ? (
              <LiveColumnsView />
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
        </div>

        <Suspense>
          {!(
            generalSettingsOpen ||
            settingsOpen ||
            analyticsOpen ||
            liveColumnsOpen ||
            automationInboxOpen ||
            addProjectOpen
          ) && <TerminalPanel />}
        </Suspense>
      </SidebarInset>

      {/* Right sidebar — tabbed pane (Review / Tests) with CSS transition slide in/out.
          ReviewPane is eagerly mounted (hidden) after initial idle to eliminate
          ~500ms first-open delay from lazy loading + mount + diff fetch. */}
      <div
        className={cn(
          'relative flex h-full overflow-hidden flex-shrink-0 bg-sidebar',
          !rpResizing && 'transition-[width,opacity] duration-200 ease-out',
          reviewPaneOpen && !settingsOpen && !allThreadsProjectId ? 'opacity-100' : 'w-0 opacity-0',
        )}
        style={{
          contain: 'layout style',
          ...(reviewPaneOpen && !settingsOpen && !allThreadsProjectId
            ? { width: `${activeWidth}vw` }
            : {}),
        }}
      >
        {/* Resize handle */}
        {reviewPaneOpen && !settingsOpen && !allThreadsProjectId && (
          <ResizeHandle
            direction="horizontal"
            resizing={rpResizing}
            onPointerDown={handleRpPointerDown}
            onPointerMove={handleRpPointerMove}
            onPointerUp={handleRpPointerUp}
          />
        )}
        {(reviewPaneReady || reviewPaneOpen) && (
          <div
            className="flex h-full min-w-0 flex-1 flex-col"
            style={{
              ...(!(reviewPaneOpen && !settingsOpen && !allThreadsProjectId)
                ? { visibility: 'hidden' as const }
                : {}),
            }}
          >
            {/* Pane content — controlled by header toggle buttons */}
            <div className="min-h-0 flex-1 overflow-hidden">
              <Suspense>
                {rightPaneTab === 'review' ? (
                  <ReviewPane />
                ) : rightPaneTab === 'tasks' ? (
                  <TasksPane />
                ) : (
                  <TestRunnerPane />
                )}
              </Suspense>
            </div>
          </div>
        )}
      </div>

      <Toaster position="bottom-right" duration={TOAST_DURATION} />
      <Suspense>
        <CircuitBreakerDialog />
      </Suspense>
      <Suspense>
        <CommandPalette open={commandPaletteOpen} onOpenChange={setCommandPaletteOpen} />
      </Suspense>

      {/* Internal Monaco Editor Dialog (global, lazy-loaded) */}
      {internalEditorOpen && (
        <Suspense>
          <MonacoEditorDialog
            open={true}
            onOpenChange={(open) => {
              if (!open) useInternalEditorStore.getState().closeEditor();
            }}
            filePath={internalEditorFilePath || ''}
            initialContent={internalEditorContent}
          />
        </Suspense>
      )}
    </SidebarProvider>
  );
}
