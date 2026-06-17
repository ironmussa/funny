import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';

import { terminalRegistry } from '@/components/terminal/xterm-utils';
import { getTerminalScope } from '@/hooks/use-terminal-scope';
import { createClientLogger } from '@/lib/client-logger';
import { buildPath } from '@/lib/url';
import { useProjectStore } from '@/stores/project-store';
import { SCRATCH_TERMINAL_SCOPE_ID, useTerminalStore } from '@/stores/terminal-store';
import { type ThreadHistoryEntry, useThreadHistoryStore } from '@/stores/thread-history-store';
import { useThreadStore } from '@/stores/thread-store';
import { useUIStore } from '@/stores/ui-store';

function routeForHistoryEntry(entry: ThreadHistoryEntry): string {
  if (entry.isScratch) return `/scratch/${entry.threadId}`;
  return `/projects/${entry.projectId}/threads/${entry.threadId}`;
}

const log = createClientLogger('hooks:global-shortcuts');

function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

export function useGlobalShortcuts(
  toggleCommandPalette: () => void,
  toggleFileSearch: () => void,
  toggleTextSearch: () => void,
) {
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

      // Alt+ArrowLeft / Alt+ArrowRight to walk through visited threads (browser-style)
      if (
        e.altKey &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.shiftKey &&
        (e.key === 'ArrowLeft' || e.key === 'ArrowRight')
      ) {
        if (isEditableTarget(e.target)) return;
        const history = useThreadHistoryStore.getState();
        const entry = e.key === 'ArrowLeft' ? history.goBack() : history.goForward();
        if (!entry) return;
        e.preventDefault();
        e.stopPropagation();
        log.info('shortcut.thread_history', {
          direction: e.key === 'ArrowLeft' ? 'back' : 'forward',
        });
        navigate(buildPath(routeForHistoryEntry(entry)));
        return;
      }

      // Alt+] / Alt+[ to navigate threads in active project (next / previous).
      // Intentionally fires even when an editable element (e.g. the prompt
      // input) has focus — after navigating to a new thread the prompt input
      // auto-focuses, so requiring non-editable focus would make the second
      // press a no-op.
      if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && (e.key === ']' || e.key === '[')) {
        const activeThreadProjectId = useThreadStore.getState().activeThread?.projectId ?? null;
        const projectId = activeThreadProjectId ?? useProjectStore.getState().selectedProjectId;
        if (!projectId) return;
        const state = useThreadStore.getState();
        const ids = state.threadIdsByProject[projectId] ?? [];
        if (ids.length < 2) return;
        // Match the sidebar's visible order + slice (see ProjectItem.tsx):
        // pinned first, then most-recent createdAt first, archived hidden,
        // capped at the top 5 visible rows so cycling stays within what the
        // user actually sees in the sidebar.
        const threads = ids
          .map((id) => state.threadsById[id])
          .filter((th): th is NonNullable<typeof th> => !!th && !th.archived)
          .sort((a, b) => {
            if (a.pinned && !b.pinned) return -1;
            if (!a.pinned && b.pinned) return 1;
            return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
          })
          .slice(0, 5);
        if (threads.length < 2) return;
        // Prefer `selectedThreadId` over `activeThread?.id`: on rapid Alt+]/Alt+[
        // presses, `activeThread` is briefly null while the next thread loads,
        // but `selectedThreadId` is updated synchronously by `selectThread()`.
        // Without this, consecutive presses snapped to `threads[1]` /
        // `threads[length-1]` regardless of current position.
        const currentId = state.selectedThreadId ?? state.activeThread?.id ?? null;
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

      // Alt+G / Alt+F / Alt+H / Alt+M toggle the right-sidebar panels:
      //   Alt+G → commit (review/diff)    Alt+F → file manager (project files)
      //   Alt+H → share dialog            Alt+M → comments
      // preventDefault() also suppresses the macOS Option+letter typographic
      // glyphs and Chrome's Alt+F app-menu when the key is handled here.
      if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
        const k = e.key.toLowerCase();
        if (k === 'g' || k === 'f' || k === 'h' || k === 'm') {
          const ui = useUIStore.getState();
          e.preventDefault();
          e.stopPropagation();
          if (k === 'g') {
            log.info('shortcut.toggle_review');
            ui.setReviewPaneOpen(!(ui.reviewPaneOpen && ui.rightPaneTab === 'review'));
          } else if (k === 'f') {
            log.info('shortcut.toggle_files');
            ui.setFilesPaneOpen(!(ui.reviewPaneOpen && ui.rightPaneTab === 'files'));
          } else if (k === 'm') {
            log.info('shortcut.toggle_comments');
            ui.setCommentsPaneOpen(!(ui.reviewPaneOpen && ui.rightPaneTab === 'comments'));
          } else {
            // Share is owner-only: the dialog mounts only when the header's
            // Share button is rendered. Gate on its presence so we never strand
            // a stale `shareDialogOpen` flag on a thread with no share dialog.
            if (document.querySelector('[data-testid="header-share-thread"]')) {
              log.info('shortcut.toggle_share');
              ui.toggleShareDialog();
            }
          }
          return;
        }
      }

      // Ctrl+Shift+L for thread list/search — scope to current thread's project
      // by default. (Was Ctrl+Shift+F until text-in-files search took that slot
      // to match the VSCode convention.)
      if (e.ctrlKey && e.shiftKey && !e.altKey && (e.key === 'L' || e.key === 'l')) {
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
          const willOpen = !isVisible;
          store.togglePanel(scopeId);
          // When opening (not hiding), place the caret in the active terminal so
          // the user can type immediately. Hiding the panel unmounts the dockview
          // terminal (xterm is destroyed + removed from terminalRegistry), so on
          // reopen the xterm is recreated asynchronously (getXtermModules()). A
          // single timed focus would race that creation, so retry until the
          // terminal is registered (capped), bailing if the panel is hidden again
          // or a modal dialog opens.
          if (willOpen) {
            const activeId =
              store.activeTabId && scopeTabs.some((t) => t.id === store.activeTabId)
                ? store.activeTabId
                : scopeTabs[scopeTabs.length - 1]?.id;
            if (activeId) {
              let tries = 0;
              const tryFocus = () => {
                if (!(useTerminalStore.getState().panelVisibleByProject[scopeId] ?? false)) return;
                if (document.querySelector('[role="dialog"][data-state="open"]')) return;
                const term = terminalRegistry.get(activeId);
                if (term) {
                  term.focus();
                  return;
                }
                if (tries++ < 30) setTimeout(tryFocus, 60);
              };
              setTimeout(tryFocus, 60);
            }
          }
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [navigate, toggleCommandPalette, toggleFileSearch, toggleTextSearch]);

  // Ctrl+Shift+F for text search (matches VSCode). Registered in CAPTURE
  // phase with `stopImmediatePropagation` so no component listener can
  // swallow it. Uses `e.code === 'KeyF'` (physical key, IME/layout-
  // independent) rather than `e.key`.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!e.ctrlKey || !e.shiftKey || e.altKey || e.metaKey) return;
      if (e.code !== 'KeyF') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      log.info('shortcut.text_search');
      toggleTextSearch();
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [toggleTextSearch]);
}
