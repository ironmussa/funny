import { startTransition, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';

import { buildPath } from '@/lib/url';
import { useProjectStore } from '@/stores/project-store';
import { useTerminalStore } from '@/stores/terminal-store';

export function useGlobalShortcuts(
  onToggleCommandPalette: () => void,
  onToggleFileSearch: () => void,
) {
  const navigate = useNavigate();

  useEffect(() => {
    const isTauri = !!(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__;

    const handler = (e: KeyboardEvent) => {
      // Ctrl+K for command palette (toggle)
      if (e.ctrlKey && e.key === 'k') {
        e.preventDefault();
        e.stopPropagation();
        startTransition(() => {
          onToggleCommandPalette();
        });
        return;
      }

      // Ctrl+P for file search (toggle)
      if (e.ctrlKey && e.key === 'p') {
        e.preventDefault();
        e.stopPropagation();
        startTransition(() => {
          onToggleFileSearch();
        });
        return;
      }

      // Ctrl+Shift+F for global thread search
      if (e.ctrlKey && e.shiftKey && e.key === 'F') {
        e.preventDefault();
        e.stopPropagation();
        navigate(buildPath('/list'));
        return;
      }

      // Ctrl+` to toggle terminal (only in Tauri mode)
      if (e.ctrlKey && e.key === '`') {
        e.preventDefault();
        if (!isTauri) return;
        const store = useTerminalStore.getState();
        const { selectedProjectId, projects } = useProjectStore.getState();
        if (!selectedProjectId) return;
        const projectTabs = store.tabs.filter((t) => t.projectId === selectedProjectId);
        if (projectTabs.length === 0 && !store.panelVisible) {
          const project = projects.find((p: any) => p.id === selectedProjectId);
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
  }, [navigate, onToggleCommandPalette, onToggleFileSearch]);
}
