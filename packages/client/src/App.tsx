import { lazy, Suspense, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AnimatePresence, motion } from 'motion/react';
import { useWS } from '@/hooks/use-ws';
import { useRouteSync } from '@/hooks/use-route-sync';
import { useProjectStore } from '@/stores/project-store';
import { useUIStore } from '@/stores/ui-store';
import { useWorkflowStore } from '@/stores/workflow-store';
import { setAppNavigate } from '@/stores/thread-store';
import { useTerminalStore } from '@/stores/terminal-store';
import { useInternalEditorStore } from '@/stores/internal-editor-store';
import { AppSidebar } from '@/components/Sidebar';
import { ThreadView } from '@/components/ThreadView';
import { MonacoEditorDialog } from '@/components/MonacoEditorDialog';
import { SidebarProvider, SidebarInset, useSidebar } from '@/components/ui/sidebar';
import { Toaster } from 'sonner';
import { TOAST_DURATION } from '@/lib/utils';
import { PanelLeft } from 'lucide-react';

/** Thin vertical strip visible when the sidebar is collapsed, click to reopen */
function CollapsedSidebarStrip() {
  const { state, toggleSidebar } = useSidebar();
  if (state === 'expanded') return null;
  return (
    <button
      onClick={toggleSidebar}
      className="flex-shrink-0 w-10 h-full border-r border-border bg-sidebar flex items-start justify-center pt-3 hover:bg-sidebar-accent transition-colors cursor-pointer"
      title="Expand sidebar"
    >
      <PanelLeft className="h-4 w-4 text-muted-foreground" />
    </button>
  );
}

// Lazy-load conditional views (bundle-conditional / bundle-dynamic-imports)
const AllThreadsView = lazy(() => import('@/components/AllThreadsView').then(m => ({ default: m.AllThreadsView })));
const ReviewPane = lazy(() => import('@/components/ReviewPane').then(m => ({ default: m.ReviewPane })));
const TerminalPanel = lazy(() => import('@/components/TerminalPanel').then(m => ({ default: m.TerminalPanel })));
const SettingsDetailView = lazy(() => import('@/components/SettingsDetailView').then(m => ({ default: m.SettingsDetailView })));
const AutomationInboxView = lazy(() => import('@/components/AutomationInboxView').then(m => ({ default: m.AutomationInboxView })));
const AddProjectView = lazy(() => import('@/components/AddProjectView').then(m => ({ default: m.AddProjectView })));
const AnalyticsView = lazy(() => import('@/components/AnalyticsView').then(m => ({ default: m.AnalyticsView })));
const LiveColumnsView = lazy(() => import('@/components/LiveColumnsView').then(m => ({ default: m.LiveColumnsView })));
const CommandPalette = lazy(() => import('@/components/CommandPalette').then(m => ({ default: m.CommandPalette })));
const CircuitBreakerDialog = lazy(() => import('@/components/CircuitBreakerDialog').then(m => ({ default: m.CircuitBreakerDialog })));
const WorkflowProgressPanel = lazy(() => import('@/components/WorkflowProgressPanel').then(m => ({ default: m.WorkflowProgressPanel })));
const NewThreadDialog = lazy(() => import('@/components/NewThreadDialog').then(m => ({ default: m.NewThreadDialog })));

export function App() {
  const loadProjects = useProjectStore(s => s.loadProjects);
  const reviewPaneOpen = useUIStore(s => s.reviewPaneOpen);
  const setReviewPaneOpen = useUIStore(s => s.setReviewPaneOpen);
  const settingsOpen = useUIStore(s => s.settingsOpen);
  const allThreadsProjectId = useUIStore(s => s.allThreadsProjectId);
  const automationInboxOpen = useUIStore(s => s.automationInboxOpen);
  const addProjectOpen = useUIStore(s => s.addProjectOpen);
  const analyticsOpen = useUIStore(s => s.analyticsOpen);
  const liveColumnsOpen = useUIStore(s => s.liveColumnsOpen);
  const workflowRunSelected = useWorkflowStore(s => !!s.selectedRunId);
  const newThreadProjectId = useUIStore(s => s.newThreadProjectId);
  const navigate = useNavigate();
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);

  // Register navigate so the store can trigger navigation (e.g. from toasts)
  useEffect(() => { setAppNavigate(navigate); }, [navigate]);

  // Connect WebSocket on mount
  useWS();

  // Sync URL ↔ store
  useRouteSync();

  // Load projects on mount (auth already initialized by AuthGate)
  useEffect(() => {
    loadProjects();
  }, [loadProjects]);

  // Global keyboard shortcuts
  useEffect(() => {
    const isTauri = !!(window as unknown as { __TAURI_INTERNALS__: unknown })
      .__TAURI_INTERNALS__;

    const handler = (e: KeyboardEvent) => {
      // Ctrl+K for command palette (toggle)
      if (e.ctrlKey && e.key === 'k') {
        e.preventDefault();
        e.stopPropagation();
        setCommandPaletteOpen(prev => !prev);
        return;
      }

      // Ctrl+Shift+F for global thread search
      if (e.ctrlKey && e.shiftKey && e.key === 'F') {
        e.preventDefault();
        e.stopPropagation();
        navigate('/search');
        return;
      }

      // Ctrl+` to toggle terminal (only in Tauri mode)
      if (e.ctrlKey && e.key === '`') {
        e.preventDefault();
        if (!isTauri) return; // Terminal panel only works in Tauri desktop app
        const store = useTerminalStore.getState();
        const { selectedProjectId, projects } = useProjectStore.getState();
        if (!selectedProjectId) return;
        const projectTabs = store.tabs.filter(
          (t) => t.projectId === selectedProjectId
        );
        if (projectTabs.length === 0 && !store.panelVisible) {
          const project = projects.find(
            (p: any) => p.id === selectedProjectId
          );
          const cwd = project?.path ?? 'C:\\';
          store.addTab({
            id: crypto.randomUUID(),
            label: 'Terminal 1',
            cwd,
            alive: true,
            projectId: selectedProjectId,
          });
        } else {
          store.togglePanel();
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  return (
    <SidebarProvider
      defaultOpen={true}
      className="h-screen overflow-hidden"
    >
      <AppSidebar />
      <CollapsedSidebarStrip />

      <SidebarInset className="flex flex-col overflow-hidden">
        {/* Main content + terminal */}
        <div className="flex-1 flex overflow-hidden min-h-0">
          <Suspense>
            {settingsOpen ? <SettingsDetailView /> : analyticsOpen ? <AnalyticsView /> : liveColumnsOpen ? <LiveColumnsView /> : automationInboxOpen ? <AutomationInboxView /> : addProjectOpen ? <AddProjectView /> : allThreadsProjectId ? <AllThreadsView /> : workflowRunSelected ? <WorkflowProgressPanel /> : <ThreadView />}
          </Suspense>
        </div>

        <Suspense><TerminalPanel /></Suspense>
      </SidebarInset>

      {/* Right sidebar for review pane — animated slide in/out */}
      <AnimatePresence>
        {reviewPaneOpen && !settingsOpen && !allThreadsProjectId && (
          <motion.div
            key="review-pane"
            initial={{ width: 0, opacity: 0 }}
            animate={{ width: '50vw', opacity: 1 }}
            exit={{ width: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: [0.25, 0.1, 0.25, 1] }}
            className="h-full overflow-hidden flex-shrink-0 border-l border-border"
          >
            <div className="h-full w-[50vw]">
              <Suspense><ReviewPane /></Suspense>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <Toaster position="bottom-right" theme="dark" duration={TOAST_DURATION} />
      <Suspense><CircuitBreakerDialog /></Suspense>
      {commandPaletteOpen && <Suspense><CommandPalette open={commandPaletteOpen} onOpenChange={setCommandPaletteOpen} /></Suspense>}

      {/* Internal Monaco Editor Dialog (global) */}
      <MonacoEditorDialog
        open={useInternalEditorStore((s) => s.isOpen)}
        onOpenChange={(open) => {
          if (!open) useInternalEditorStore.getState().closeEditor();
        }}
        filePath={useInternalEditorStore((s) => s.filePath) || ''}
      />
      {newThreadProjectId && <Suspense><NewThreadDialog /></Suspense>}
    </SidebarProvider>
  );
}
