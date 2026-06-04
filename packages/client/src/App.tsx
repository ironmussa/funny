import { lazy, Suspense, useEffect, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';

import { CenterDockview } from '@/components/CenterDockview';
import { DockviewLayout, type RightTabSpec } from '@/components/DockviewLayout';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import {
  ChangesPanel,
  HistoryPanel,
  PRsPanel,
  StashPanel,
} from '@/components/review-pane/panels/ChangesPanel';
import { ReviewPaneStateProvider } from '@/components/review-pane/ReviewPaneStateContext';
import { useTerminalDockview } from '@/components/terminal/TerminalDockview';
import { ProjectHeader } from '@/components/thread/ProjectHeader';
import { LoadingState } from '@/components/ui/loading-state';
import { SidebarProvider, SidebarInset, useSidebar } from '@/components/ui/sidebar';
import { Toaster } from '@/components/ui/sonner';
import { WorkflowErrorModal } from '@/components/WorkflowErrorModal';
import { useActiveThreadId } from '@/hooks/use-active-thread-id';
import { useDisplayThreadId } from '@/hooks/use-display-thread-id';
import { useDocumentTitle } from '@/hooks/use-document-title';
import { useGlobalShortcuts } from '@/hooks/use-global-shortcuts';
import { useRouteSync } from '@/hooks/use-route-sync';
import { useTauriAnnotatorEvents } from '@/hooks/use-tauri-annotator-events';
import { useThreadHistoryTracker } from '@/hooks/use-thread-history-tracker';
import { useWS } from '@/hooks/use-ws';
import { canDoGitOps } from '@/lib/thread-variant';
import { cn } from '@/lib/utils';
import { TOAST_DURATION } from '@/lib/utils';
import { useAgentTemplateStore } from '@/stores/agent-template-store';
import { useBrowserPanelStore } from '@/stores/browser-panel-store';
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
const DEFAULT_SIDEBAR_WIDTH = 240;

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
const OrchestratorView = lazy(() =>
  import('@/components/OrchestratorView').then((m) => ({ default: m.OrchestratorView })),
);
// Eagerly start the CommandPalette chunk download at module-eval time so
// Ctrl+K is instant. requestIdleCallback was firing too late on busy main
// threads and the user saw a load delay before the dialog appeared.
const commandPaletteImport = import('@/components/CommandPalette').then((m) => ({
  default: m.CommandPalette,
}));
const CommandPalette = lazy(() => commandPaletteImport);
const fileSearchImport = import('@/components/FileSearchDialog').then((m) => ({
  default: m.FileSearchDialog,
}));
const FileSearchDialog = lazy(() => fileSearchImport);
const textSearchImport = import('@/components/TextSearchDialog').then((m) => ({
  default: m.TextSearchDialog,
}));
const TextSearchDialog = lazy(() => textSearchImport);
// Prefetch ReviewPane on idle so the first toggle is instant.
if (typeof requestIdleCallback === 'function') {
  requestIdleCallback(() => {
    reviewPaneImport();
  });
} else {
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
const BrowserPanel = lazy(() =>
  import('@/components/browser-panel/BrowserPanel').then((m) => ({ default: m.BrowserPanel })),
);

export function App() {
  const loadProjects = useProjectStore((s) => s.loadProjects);
  const loadTemplates = useAgentTemplateStore((s) => s.loadTemplates);
  const loadScratchThreads = useThreadStore((s) => s.loadScratchThreads);
  const reviewPaneOpen = useUIStore((s) => s.reviewPaneOpen);
  const reviewPaneWidth = useUIStore((s) => s.reviewPaneWidth);
  const rightPaneTab = useUIStore((s) => s.rightPaneTab);
  const settingsOpen = useUIStore((s) => s.settingsOpen);
  const generalSettingsOpen = useUIStore((s) => s.generalSettingsOpen);
  const allThreadsProjectId = useUIStore((s) => s.allThreadsProjectId);
  const automationInboxOpen = useUIStore((s) => s.automationInboxOpen);
  const addProjectOpen = useUIStore((s) => s.addProjectOpen);
  const analyticsOpen = useUIStore((s) => s.analyticsOpen);
  const liveColumnsOpen = useUIStore((s) => s.liveColumnsOpen);
  const orchestratorOpen = useUIStore((s) => s.orchestratorOpen);
  const testRunnerOpen = useUIStore((s) => s.testRunnerOpen);
  const internalEditorOpen = useInternalEditorStore((s) => s.isOpen);
  const internalEditorFilePath = useInternalEditorStore((s) => s.filePath);
  const internalEditorContent = useInternalEditorStore((s) => s.initialContent);
  // App-wide thread context is anchored to the URL (route-driven). The chat
  // pane uses the deferred displayThreadId below for INP; everything else
  // (header, review pane) reads this immediate, URL-derived id.
  const activeThreadId = useActiveThreadId();
  const displayThreadId = useDisplayThreadId();
  const activeThreadCanShowGit = useThreadStore((s) => canDoGitOps(s.activeThread));
  const hasSelectedProject = useProjectStore((s) => s.selectedProjectId != null);
  const navigate = useNavigate();
  const commandPaletteOpen = useUIStore((s) => s.commandPaletteOpen);
  const setCommandPaletteOpen = useUIStore((s) => s.setCommandPaletteOpen);
  const fileSearchOpen = useUIStore((s) => s.fileSearchOpen);
  const setFileSearchOpen = useUIStore((s) => s.setFileSearchOpen);

  // --- Right panel layout ---
  const isFullScreenView =
    settingsOpen ||
    generalSettingsOpen ||
    analyticsOpen ||
    liveColumnsOpen ||
    orchestratorOpen ||
    testRunnerOpen ||
    automationInboxOpen ||
    addProjectOpen ||
    !!allThreadsProjectId;
  // Note: right-pane resize is now handled by dockview's panel splitters.

  // Browser annotator panel — now lives as a native dockview panel; resize
  // and persistence are handled by dockview's splitter + storage.
  const browserPanelOpen = useBrowserPanelStore((s) => s.open);
  const browserPanelWidth = useBrowserPanelStore((s) => s.browserPanelWidth);
  const togglebrowserPanel = useBrowserPanelStore((s) => s.togglePanel);

  // Register navigate so the store can trigger navigation (e.g. from toasts)
  useEffect(() => {
    setAppNavigate(navigate);
  }, [navigate]);

  // Connect WebSocket on mount
  useWS();

  // Sync URL ↔ store
  useRouteSync();

  // Load projects, agent templates, and scratch threads on mount (auth already initialized by AuthGate)
  useEffect(() => {
    loadProjects();
    loadTemplates();
    loadScratchThreads();
  }, [loadProjects, loadTemplates, loadScratchThreads]);

  useDocumentTitle();

  // Global keyboard shortcuts (extracted to dedicated hook). All three dialog
  // toggles must go through the store so its mutual-exclusion logic fires
  // (opening one closes the others — see ui-store setters).
  const toggleCommandPalette = useUIStore((s) => s.toggleCommandPalette);
  const toggleFileSearch = useUIStore((s) => s.toggleFileSearch);
  const textSearchOpen = useUIStore((s) => s.textSearchOpen);
  const setTextSearchOpen = useUIStore((s) => s.setTextSearchOpen);
  const toggleTextSearch = useUIStore((s) => s.toggleTextSearch);
  useGlobalShortcuts(toggleCommandPalette, toggleFileSearch, toggleTextSearch);
  useThreadHistoryTracker();
  useTauriAnnotatorEvents();

  // Terminals live as native dockview tabs below the center pane.
  const terminalDockview = useTerminalDockview();

  // --- Dockview panels ---

  const leftPanel = (
    <ErrorBoundary area="sidebar">
      <Suspense fallback={<SidebarPlaceholder />}>
        <AppSidebar />
      </Suspense>
    </ErrorBoundary>
  );

  const rightPaneVisible = reviewPaneOpen && !isFullScreenView;
  const reviewSubTab = useUIStore((s) => s.reviewSubTab);
  const setReviewSubTabStore = useUIStore((s) => s.setReviewSubTab);

  // When the user is on the review tab and has git context, the right pane
  // is split into 4 native dockview tabs (Changes/History/Stash/PRs). For the
  // other top-level tabs (files / activity / project-mode), we fall back to a
  // single header-less panel.
  const useReviewTabs = rightPaneTab === 'review' && (activeThreadCanShowGit || hasSelectedProject);

  const rightTabs: RightTabSpec[] | undefined = useReviewTabs
    ? [
        { id: 'changes', title: 'Changes', content: <ChangesPanel /> },
        { id: 'history', title: 'History', content: <HistoryPanel /> },
        { id: 'stash', title: 'Stash', content: <StashPanel /> },
        { id: 'prs', title: 'PRs', content: <PRsPanel /> },
      ]
    : undefined;

  const singleRightPanel = !useReviewTabs ? (
    <div className="h-full w-full overflow-hidden bg-sidebar">
      <ErrorBoundary area="right-pane">
        <Suspense fallback={<LoadingState testId="right-pane-loading" label="Loading…" />}>
          {rightPaneTab === 'files' && (activeThreadCanShowGit || hasSelectedProject) ? (
            <ProjectFilesPane />
          ) : rightPaneTab === 'activity' && !activeThreadCanShowGit && hasSelectedProject ? (
            // Compose mode (no thread) — activity has nothing to render, so
            // show the branch-level review instead via tabs at next render.
            <ReviewPane />
          ) : (
            <ActivityPane />
          )}
        </Suspense>
      </ErrorBoundary>
    </div>
  ) : undefined;

  const threadContent = (
    <ErrorBoundary area="main-content">
      {/* Overlay views — same priority cascade as before. Wrapped in its
          own Suspense so a lazy overlay's first-load suspension does not
          unmount the persistent ThreadView below. */}
      {isFullScreenView && (
        <Suspense>
          <div className="absolute inset-0 z-10 flex">
            {generalSettingsOpen ? (
              <GeneralSettingsView />
            ) : settingsOpen ? (
              <SettingsDetailView />
            ) : analyticsOpen ? (
              <AnalyticsView />
            ) : liveColumnsOpen ? (
              <LiveColumnsView />
            ) : orchestratorOpen ? (
              <OrchestratorView />
            ) : testRunnerOpen ? (
              <TestRunnerPane />
            ) : automationInboxOpen ? (
              <AutomationInboxView />
            ) : addProjectOpen ? (
              <AddProjectView />
            ) : allThreadsProjectId ? (
              <AllThreadsView />
            ) : null}
          </div>
        </Suspense>
      )}

      {/* ThreadView stays mounted under any overlay so returning from
          Settings/Analytics/etc. is instant (no message refetch / Monaco
          / syntax-highlight re-render). Hidden via display:none when an
          overlay is active. */}
      <Suspense>
        <div className={cn('flex min-h-0 min-w-0 flex-1', isFullScreenView && 'hidden')}>
          <ThreadProvider threadId={displayThreadId}>
            <ThreadView />
          </ThreadProvider>
        </div>
      </Suspense>
    </ErrorBoundary>
  );

  const centerPanel = (
    <SidebarInset className="flex h-full flex-col overflow-hidden">
      {!isFullScreenView && (
        <ErrorBoundary area="project-header">
          <ProjectHeader />
        </ErrorBoundary>
      )}
      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        <CenterDockview
          thread={<div className="relative flex h-full w-full">{threadContent}</div>}
          right={singleRightPanel}
          rightTabs={rightTabs}
          activeRightTab={reviewSubTab}
          onActiveRightTabChange={(id) => setReviewSubTabStore(id as typeof reviewSubTab)}
          rightPaneOpen={rightPaneVisible}
          initialRightWidth={Math.round(window.innerWidth * (reviewPaneWidth / 100))}
        />
      </div>
    </SidebarInset>
  );

  return (
    <SidebarProvider defaultOpen={true} className="h-screen overflow-hidden">
      <ThreadProvider threadId={activeThreadId}>
        <div className="flex min-h-0 flex-1 overflow-hidden" data-testid="main-panel-group">
          <ReviewPaneStateProvider>
            <SidebarAwareDockview
              leftPanel={leftPanel}
              centerPanel={centerPanel}
              terminalDockview={terminalDockview}
              isFullScreenView={isFullScreenView}
              browserPanelOpen={browserPanelOpen}
              togglebrowserPanel={togglebrowserPanel}
              browserPanelWidth={browserPanelWidth}
            />
          </ReviewPaneStateProvider>
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
        <Suspense>
          <TextSearchDialog open={textSearchOpen} onOpenChange={setTextSearchOpen} />
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

/** Reads the sidebar context (cookie-backed `open`) and feeds it into
 *  DockviewLayout as `leftPaneOpen` so the SidebarTopBar collapse button
 *  actually collapses the left edge group. Lives inside <SidebarProvider>. */
function SidebarAwareDockview({
  leftPanel,
  centerPanel,
  terminalDockview,
  isFullScreenView,
  browserPanelOpen,
  togglebrowserPanel,
  browserPanelWidth,
}: {
  leftPanel: ReactNode;
  centerPanel: ReactNode;
  terminalDockview: ReturnType<typeof useTerminalDockview>;
  isFullScreenView: boolean;
  browserPanelOpen: boolean;
  togglebrowserPanel: () => void;
  browserPanelWidth: number;
}) {
  const { open: sidebarOpen } = useSidebar();
  return (
    <DockviewLayout
      left={leftPanel}
      center={centerPanel}
      leftPaneOpen={sidebarOpen}
      bottomTabs={terminalDockview.bottomTabs}
      activeBottomTab={terminalDockview.activeBottomTab}
      onActiveBottomTabChange={terminalDockview.onActiveBottomTabChange}
      onBottomTabClose={terminalDockview.onBottomTabClose}
      onBottomTabsReorder={terminalDockview.onBottomTabsReorder}
      bottomPaneOpen={terminalDockview.bottomPaneOpen && !isFullScreenView}
      bottomPrefixActions={terminalDockview.bottomPrefixActions}
      bottomLeftActions={terminalDockview.bottomLeftActions}
      bottomRightActions={terminalDockview.bottomRightActions}
      browser={
        <Suspense fallback={null}>
          <BrowserPanel />
        </Suspense>
      }
      browserOpen={browserPanelOpen && !isFullScreenView}
      onBrowserClose={togglebrowserPanel}
      initialLeftWidth={DEFAULT_SIDEBAR_WIDTH}
      initialBrowserWidth={browserPanelWidth}
    />
  );
}
