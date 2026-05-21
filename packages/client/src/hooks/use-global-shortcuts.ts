import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';

import { getTerminalScope } from '@/hooks/use-terminal-scope';
import { createClientLogger } from '@/lib/client-logger';
import { buildPath } from '@/lib/url';
import { useProjectStore } from '@/stores/project-store';
import { SCRATCH_TERMINAL_SCOPE_ID, useTerminalStore } from '@/stores/terminal-store';
import { useThreadStore } from '@/stores/thread-store';
import { useUIStore } from '@/stores/ui-store';

const log = createClientLogger('hooks:global-shortcuts');

function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

export function useGlobalShortcuts(toggleCommandPalette: () => void, toggleFileSearch: () => void) {
  const navigate = useNavigate();

  useEffect(() => {
    const isTauri = !!(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__;

    const handler = (e: KeyboardEvent) => {
      // Ctrl+K or Ctrl+Shift+P for command palette (toggle)
      if (
        (e.ctrlKey && !e.shiftKey && !e.altKey && e.key === 'k') ||
        (e.ctrlKey && e.shiftKey && !e.altKey && (e.key === 'P' || e.key === 'p'))
      ) {
        e.preventDefault();
        e.stopPropagation();
        (window as unknown as { __paletteOpenTs?: number }).__paletteOpenTs = performance.now();
        log.info('shortcut.command_palette');
        toggleCommandPalette();
        return;
      }

      // Ctrl+P for file search (toggle)
      if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key === 'p') {
        e.preventDefault();
        e.stopPropagation();
        log.info('shortcut.file_search');
        toggleFileSearch();
        return;
      }

      // "?" to open keyboard shortcuts dialog (ignored when typing in inputs)
      if (e.key === '?' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (isEditableTarget(e.target)) return;
        e.preventDefault();
        e.stopPropagation();
        log.info('shortcut.open_shortcuts');
        useUIStore.getState().toggleKeyboardShortcuts();
        return;
      }

      // Alt+] / Alt+[ to navigate threads in active project (next / previous)
      if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && (e.key === ']' || e.key === '[')) {
        if (isEditableTarget(e.target)) return;
        const activeThreadProjectId = useThreadStore.getState().activeThread?.projectId ?? null;
        const projectId = activeThreadProjectId ?? useProjectStore.getState().selectedProjectId;
        if (!projectId) return;
        const state = useThreadStore.getState();
        const ids = state.threadIdsByProject[projectId] ?? [];
        if (ids.length < 2) return;
        const threads = ids.map((id) => state.threadsById[id]).filter(Boolean);
        if (threads.length < 2) return;
        const currentId = state.activeThread?.id ?? null;
        const currentIdx = currentId ? threads.findIndex((th) => th.id === currentId) : -1;
        const delta = e.key === ']' ? 1 : -1;
        const baseIdx = currentIdx >= 0 ? currentIdx : 0;
        const nextIdx = (baseIdx + delta + threads.length) % threads.length;
        const next = threads[nextIdx];
        if (!next) return;
        e.preventDefault();
        e.stopPropagation();
        log.info('shortcut.thread_nav', { direction: delta > 0 ? 'next' : 'prev' });
        navigate(buildPath(`/projects/${projectId}/threads/${next.id}`));
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

      // Alt+S to start a new scratch thread (projectless)
      if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        e.stopPropagation();
        log.info('shortcut.new_scratch_thread');
        useUIStore.getState().startNewScratchThread();
        navigate(buildPath('/scratch/new'));
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
        const { projects } = useProjectStore.getState();
        const { scopeId, scratchThreadId } = getTerminalScope();
        if (!scopeId) return;
        const scopeTabs = store.tabs.filter((t) => t.projectId === scopeId);
        const isVisible = store.panelVisibleByProject[scopeId] ?? false;
        if (scopeTabs.length === 0 && !isVisible) {
          let cwd: string;
          if (scopeId === SCRATCH_TERMINAL_SCOPE_ID) {
            // Runner derives the actual cwd from `scratchThreadId`; this
            // placeholder is for display only.
            cwd = '~';
          } else {
            const project = projects.find((p: any) => p.id === scopeId);
            cwd = project?.path ?? 'C:\\';
          }
          store.addTab({
            id: crypto.randomUUID(),
            label: 'Terminal 1',
            cwd,
            alive: true,
            projectId: scopeId,
            type: isTauri ? undefined : 'pty',
            scratchThreadId: scratchThreadId ?? undefined,
          });
        } else {
          store.togglePanel(scopeId);
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [navigate, toggleCommandPalette, toggleFileSearch]);
}
