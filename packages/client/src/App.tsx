import { useEffect } from 'react';
import { useWS } from '@/hooks/use-ws';
import { useRouteSync } from '@/hooks/use-route-sync';
import { useAppStore } from '@/stores/app-store';
import { useTerminalStore } from '@/stores/terminal-store';
import { Sidebar } from '@/components/Sidebar';
import { ThreadView } from '@/components/ThreadView';
import { ReviewPane } from '@/components/ReviewPane';
import { TerminalPanel } from '@/components/TerminalPanel';
import { SettingsDetailView } from '@/components/SettingsDetailView';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Toaster } from 'sonner';

export function App() {
  const { loadProjects, reviewPaneOpen, settingsOpen } = useAppStore();

  // Connect WebSocket on mount
  useWS();

  // Sync URL ↔ store
  useRouteSync();

  // Load projects on mount
  useEffect(() => {
    loadProjects();
  }, [loadProjects]);

  // Ctrl+` to toggle terminal
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === '`') {
        e.preventDefault();
        const store = useTerminalStore.getState();
        const appState = useAppStore.getState();
        if (!appState.selectedProjectId) return;
        const projectTabs = store.tabs.filter(
          (t) => t.projectId === appState.selectedProjectId
        );
        if (projectTabs.length === 0 && !store.panelVisible) {
          const project = appState.projects.find(
            (p) => p.id === appState.selectedProjectId
          );
          const cwd = project?.path ?? 'C:\\';
          store.addTab({
            id: crypto.randomUUID(),
            label: 'Terminal 1',
            cwd,
            alive: true,
            projectId: appState.selectedProjectId,
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
    <TooltipProvider delayDuration={300}>
      <div className="flex h-screen overflow-hidden">
        {/* Sidebar */}
        <aside className="w-80 flex-shrink-0 border-r border-border flex flex-col">
          <Sidebar />
        </aside>

        {/* Main content + terminal */}
        <main className="flex-1 flex flex-col overflow-hidden">
          <div className="flex-1 flex overflow-hidden min-h-0">
            {settingsOpen ? <SettingsDetailView /> : <ThreadView />}
          </div>
          <TerminalPanel />
        </main>

        {/* Review pane */}
        {reviewPaneOpen && !settingsOpen && (
          <aside className="w-[420px] flex-shrink-0 border-l border-border overflow-hidden">
            <ReviewPane />
          </aside>
        )}
      </div>

      <Toaster position="bottom-right" theme="dark" richColors />
    </TooltipProvider>
  );
}
