import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useWS } from '@/hooks/use-ws';
import { useRouteSync } from '@/hooks/use-route-sync';
import { useProjectStore } from '@/stores/project-store';
import { useUIStore } from '@/stores/ui-store';
import { setAppNavigate } from '@/stores/thread-store';
import { useTerminalStore } from '@/stores/terminal-store';
import { Sidebar } from '@/components/Sidebar';
import { ThreadView } from '@/components/ThreadView';
import { AllThreadsView } from '@/components/AllThreadsView';
import { ReviewPane } from '@/components/ReviewPane';
import { TerminalPanel } from '@/components/TerminalPanel';
import { SettingsDetailView } from '@/components/SettingsDetailView';
import { AutomationInboxView } from '@/components/AutomationInboxView';
import { AddProjectView } from '@/components/AddProjectView';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Toaster } from 'sonner';
import { CommandPalette } from '@/components/CommandPalette';

export function App() {
  const loadProjects = useProjectStore(s => s.loadProjects);
  const reviewPaneOpen = useUIStore(s => s.reviewPaneOpen);
  const settingsOpen = useUIStore(s => s.settingsOpen);
  const allThreadsProjectId = useUIStore(s => s.allThreadsProjectId);
  const automationInboxOpen = useUIStore(s => s.automationInboxOpen);
  const addProjectOpen = useUIStore(s => s.addProjectOpen);
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

    console.log('[App] Registering keydown handler', new Error().stack);
    const handler = (e: KeyboardEvent) => {
      // Ctrl+K for command palette (toggle)
      if (e.ctrlKey && e.key === 'k') {
        e.preventDefault();
        e.stopPropagation();
        console.log('[App] Ctrl+K pressed, toggling command palette');
        setCommandPaletteOpen(prev => {
          console.log('[App] setCommandPaletteOpen prev=', prev, '-> next=', !prev);
          return !prev;
        });
        return;
      }

      // Ctrl+Shift+F for global thread search
      if (e.ctrlKey && e.shiftKey && e.key === 'F') {
        e.preventDefault();
        e.stopPropagation();
        useUIStore.getState().showGlobalSearch();
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
    return () => {
      console.log('[App] Removing keydown handler');
      window.removeEventListener('keydown', handler);
    };
  }, []);

  return (
    <TooltipProvider delayDuration={300} disableHoverableContent>
      <div className="flex h-screen overflow-hidden">
        {/* Sidebar */}
        <aside className="w-80 flex-shrink-0 border-r border-border flex flex-col">
          <Sidebar />
        </aside>

        {/* Main content + terminal */}
        <main className="flex-1 flex flex-col overflow-hidden">
          <div className="flex-1 flex overflow-hidden min-h-0">
            {settingsOpen ? <SettingsDetailView /> : automationInboxOpen ? <AutomationInboxView /> : addProjectOpen ? <AddProjectView /> : allThreadsProjectId ? <AllThreadsView /> : <ThreadView />}
          </div>
          <TerminalPanel />
        </main>

        {/* Review pane */}
        {reviewPaneOpen && !settingsOpen && (
          <aside className="w-[clamp(420px,40vw,960px)] flex-shrink-0 border-l border-border overflow-hidden">
            <ReviewPane />
          </aside>
        )}
      </div>

      <Toaster position="bottom-left" theme="dark" duration={2000} />
      {commandPaletteOpen && <CommandPalette open={commandPaletteOpen} onOpenChange={setCommandPaletteOpen} />}
    </TooltipProvider>
  );
}
