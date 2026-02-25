import { lazy, Suspense, useEffect, useState, startTransition } from 'react';
import { useNavigate } from 'react-router-dom';
import { cn } from '@/lib/utils';
import { useWS } from '@/hooks/use-ws';
import { useRouteSync } from '@/hooks/use-route-sync';
import { useProjectStore } from '@/stores/project-store';
import { useUIStore } from '@/stores/ui-store';
import { setAppNavigate } from '@/stores/thread-store';
import { useTerminalStore } from '@/stores/terminal-store';
import { useInternalEditorStore } from '@/stores/internal-editor-store';
import { SidebarProvider, SidebarInset, useSidebar } from '@/components/ui/sidebar';
import { Toaster } from 'sonner';
import { TOAST_DURATION } from '@/lib/utils';
import { PanelLeft } from 'lucide-react';

const AppSidebar = lazy(() => import('@/components/Sidebar').then(m => ({ default: m.AppSidebar })));
// Prefetch ThreadView immediately — it's the primary view users always see.
// This fires the chunk download in parallel with auth bootstrap.
const threadViewImport = import('@/components/ThreadView').then(m => ({ default: m.ThreadView }));
const ThreadView = lazy(() => threadViewImport);

const SIDEBAR_WIDTH_STORAGE_KEY = 'sidebar_width';
const DEFAULT_SIDEBAR_WIDTH = 320;

/** Placeholder matching the persisted sidebar width to avoid CLS during lazy load */
function SidebarPlaceholder() {
  let w = DEFAULT_SIDEBAR_WIDTH;
  try { const s = localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY); if (s) w = Number(s); } catch {}
  return <div style={{ width: w }} className="flex-shrink-0 bg-sidebar border-r border-sidebar-border" />;
}

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
const reviewPaneImport = () => import('@/components/ReviewPane').then(m => ({ default: m.ReviewPane }));
const ReviewPane = lazy(reviewPaneImport);
const TerminalPanel = lazy(() => import('@/components/TerminalPanel').then(m => ({ default: m.TerminalPanel })));
const SettingsDetailView = lazy(() => import('@/components/SettingsDetailView').then(m => ({ default: m.SettingsDetailView })));
const AutomationInboxView = lazy(() => import('@/components/AutomationInboxView').then(m => ({ default: m.AutomationInboxView })));
const AddProjectView = lazy(() => import('@/components/AddProjectView').then(m => ({ default: m.AddProjectView })));
const AnalyticsView = lazy(() => import('@/components/AnalyticsView').then(m => ({ default: m.AnalyticsView })));
const LiveColumnsView = lazy(() => import('@/components/LiveColumnsView').then(m => ({ default: m.LiveColumnsView })));
const commandPaletteImport = () => import('@/components/CommandPalette').then(m => ({ default: m.CommandPalette }));
const CommandPalette = lazy(commandPaletteImport);
// Prefetch the CommandPalette and ReviewPane chunks on idle so they open instantly
if (typeof requestIdleCallback === 'function') {
  requestIdleCallback(() => { commandPaletteImport(); });
  requestIdleCallback(() => { reviewPaneImport(); });
} else {
  setTimeout(() => { commandPaletteImport(); }, 2000);
  setTimeout(() => { reviewPaneImport(); }, 3000);
}
const CircuitBreakerDialog = lazy(() => import('@/components/CircuitBreakerDialog').then(m => ({ default: m.CircuitBreakerDialog })));
const MonacoEditorDialog = lazy(() => import('@/components/MonacoEditorDialog').then(m => ({ default: m.MonacoEditorDialog })));

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
  const internalEditorOpen = useInternalEditorStore(s => s.isOpen);
  const internalEditorFilePath = useInternalEditorStore(s => s.filePath);
  const internalEditorContent = useInternalEditorStore(s => s.initialContent);
  const navigate = useNavigate();
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
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
        startTransition(() => {
          setCommandPaletteOpen(prev => !prev);
        });
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
      <Suspense fallback={<SidebarPlaceholder />}><AppSidebar /></Suspense>
      <CollapsedSidebarStrip />

      <SidebarInset className="flex flex-col overflow-hidden">
        {/* Main content + terminal */}
        <div className="flex-1 flex overflow-hidden min-h-0">
          <Suspense>
            {settingsOpen ? <SettingsDetailView /> : analyticsOpen ? <AnalyticsView /> : liveColumnsOpen ? <LiveColumnsView /> : automationInboxOpen ? <AutomationInboxView /> : addProjectOpen ? <AddProjectView /> : allThreadsProjectId ? <AllThreadsView /> : <ThreadView />}
          </Suspense>
        </div>

        <Suspense><TerminalPanel /></Suspense>
      </SidebarInset>

      {/* Right sidebar for review pane — CSS transition slide in/out.
          ReviewPane is eagerly mounted (hidden) after initial idle to eliminate
          ~500ms first-open delay from lazy loading + mount + diff fetch. */}
      <div
        className={cn(
          'h-full overflow-hidden flex-shrink-0 border-l border-border transition-[width,opacity] duration-200 ease-out',
          reviewPaneOpen && !settingsOpen && !allThreadsProjectId
            ? 'w-[50vw] opacity-100'
            : 'w-0 opacity-0 border-l-0'
        )}
      >
        {(reviewPaneReady || reviewPaneOpen) && (
          <div className="h-full w-[50vw]" style={!(reviewPaneOpen && !settingsOpen && !allThreadsProjectId) ? { visibility: 'hidden' } : undefined}>
            <Suspense><ReviewPane /></Suspense>
          </div>
        )}
      </div>

      <Toaster position="bottom-right" theme="dark" duration={TOAST_DURATION} />
      <Suspense><CircuitBreakerDialog /></Suspense>
      <Suspense><CommandPalette open={commandPaletteOpen} onOpenChange={setCommandPaletteOpen} /></Suspense>

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
