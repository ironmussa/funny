import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';

import { createClientLogger } from '@/lib/client-logger';
import { buildPath } from '@/lib/url';
import { useProjectStore } from '@/stores/project-store';
import { useTerminalStore } from '@/stores/terminal-store';
import { useThreadStore } from '@/stores/thread-store';
import { useUIStore } from '@/stores/ui-store';

const log = createClientLogger('hooks:global-shortcuts');

export function useGlobalShortcuts(toggleCommandPalette: () => void, toggleFileSearch: () => void) {
  const navigate = useNavigate();

  useEffect(() => {
    const isTauri = !!(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__;

    const handler = (e: KeyboardEvent) => {
      // Ctrl+K for command palette (toggle)
      if (e.ctrlKey && e.key === 'k') {
        e.preventDefault();
        e.stopPropagation();
        (window as unknown as { __paletteOpenTs?: number }).__paletteOpenTs = performance.now();
        log.info('shortcut.command_palette');
        toggleCommandPalette();
        return;
      }

      // Ctrl+P for file search (toggle)
      if (e.ctrlKey && e.key === 'p') {
        e.preventDefault();
        e.stopPropagation();
        log.info('shortcut.file_search');
        toggleFileSearch();
        return;
      }

      // Ctrl+, to open project settings (general page)
      if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && e.key === ',') {
        e.preventDefault();
        e.stopPropagation();
        const activeThreadProjectId = useThreadStore.getState().activeThread?.projectId ?? null;
        const projectId = activeThreadProjectId ?? useProjectStore.getState().selectedProjectId;
        log.info('shortcut.project_settings', { projectId });
        navigate(
          buildPath(projectId ? `/projects/${projectId}/settings/general` : `/settings/general`),
        );
        return;
      }

      // Alt+N to start a new thread for the active project
      if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && (e.key === 'n' || e.key === 'N')) {
        const activeThreadProjectId = useThreadStore.getState().activeThread?.projectId ?? null;
        const projectId = activeThreadProjectId ?? useProjectStore.getState().selectedProjectId;
        if (!projectId) return;
        e.preventDefault();
        e.stopPropagation();
        log.info('shortcut.new_thread', { projectId });
        useUIStore.getState().startNewThread(projectId);
        navigate(buildPath(`/projects/${projectId}`));
        return;
      }

      // Ctrl+Shift+F for thread search — scope to current thread's project by default
      if (e.ctrlKey && e.shiftKey && e.key === 'F') {
        e.preventDefault();
        e.stopPropagation();
        const activeThreadProjectId = useThreadStore.getState().activeThread?.projectId ?? null;
        const projectId = activeThreadProjectId ?? useProjectStore.getState().selectedProjectId;
        navigate(buildPath(projectId ? `/list?project=${projectId}` : '/list'));
        return;
      }

      // Ctrl+` to toggle terminal
      if (e.ctrlKey && (e.key === '`' || e.code === 'Backquote')) {
        e.preventDefault();
        log.info('shortcut.terminal_toggle');
        const store = useTerminalStore.getState();
        const { selectedProjectId: storeProjectId, projects } = useProjectStore.getState();
        const activeThreadProjectId = useThreadStore.getState().activeThread?.projectId ?? null;
        const selectedProjectId = storeProjectId ?? activeThreadProjectId;
        if (!selectedProjectId) return;
        const projectTabs = store.tabs.filter((t) => t.projectId === selectedProjectId);
        const isVisible = store.panelVisibleByProject[selectedProjectId] ?? false;
        if (projectTabs.length === 0 && !isVisible) {
          const project = projects.find((p: any) => p.id === selectedProjectId);
          const cwd = project?.path ?? 'C:\\';
          store.addTab({
            id: crypto.randomUUID(),
            label: 'Terminal 1',
            cwd,
            alive: true,
            projectId: selectedProjectId,
            type: isTauri ? undefined : 'pty',
          });
        } else {
          store.togglePanel(selectedProjectId);
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [navigate, toggleCommandPalette, toggleFileSearch]);
}
