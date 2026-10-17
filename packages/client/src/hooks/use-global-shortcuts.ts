import { useEffect } from 'react';
import { type NavigateFunction, useNavigate } from 'react-router-dom';

import { terminalRegistry } from '@/components/terminal/xterm-utils';
import { getTerminalScope } from '@/hooks/use-terminal-scope';
import { createClientLogger } from '@/lib/client-logger';
import { buildPath } from '@/lib/url';
import { useProjectStore } from '@/stores/project-store';
import {
  SCRATCH_TERMINAL_SCOPE_ID,
  type TerminalTab,
  useTerminalStore,
} from '@/stores/terminal-store';
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

// ── Shortcut table ──────────────────────────────────────────────

interface ShortcutContext {
  navigate: NavigateFunction;
  toggleCommandPalette: () => void;
  toggleFileSearch: () => void;
  isTauri: boolean;
  scheduleFocus: (callback: () => void) => void;
}

interface Shortcut {
  /** Debug name — not used at runtime beyond readability. */
  name: string;
  matches: (e: KeyboardEvent) => boolean;
  run: (e: KeyboardEvent, ctx: ShortcutContext) => void;
}

/** Required modifier state. Omitted modifiers are not checked. */
interface ModifierSpec {
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  meta?: boolean;
}

function hasModifiers(e: KeyboardEvent, spec: ModifierSpec): boolean {
  if (spec.ctrl !== undefined && e.ctrlKey !== spec.ctrl) return false;
  if (spec.shift !== undefined && e.shiftKey !== spec.shift) return false;
  if (spec.alt !== undefined && e.altKey !== spec.alt) return false;
  if (spec.meta !== undefined && e.metaKey !== spec.meta) return false;
  return true;
}

/** Build a matcher: modifiers match AND `e.key` is one of `keys`. */
function keyCombo(spec: ModifierSpec, ...keys: string[]): (e: KeyboardEvent) => boolean {
  return (e) => hasModifiers(e, spec) && keys.includes(e.key);
}

const ALT_ONLY: ModifierSpec = { alt: true, ctrl: false, meta: false, shift: false };
const isCtrlK = keyCombo({ ctrl: true, shift: false, alt: false }, 'k');
const isCtrlShiftP = keyCombo({ ctrl: true, shift: true, alt: false }, 'P', 'p');

function consume(e: KeyboardEvent): void {
  e.preventDefault();
  e.stopPropagation();
}

/** Project of the active thread, falling back to the selected project. */
function activeProjectId(): string | null {
  const activeThreadProjectId = useThreadStore.getState().activeThread?.projectId ?? null;
  return activeThreadProjectId ?? useProjectStore.getState().selectedProjectId;
}

function openCommandPalette(e: KeyboardEvent, ctx: ShortcutContext): void {
  consume(e);
  (window as unknown as { __paletteOpenTs?: number }).__paletteOpenTs = performance.now();
  log.info('shortcut.command_palette');
  ctx.toggleCommandPalette();
}

function openFileSearch(e: KeyboardEvent, ctx: ShortcutContext): void {
  consume(e);
  log.info('shortcut.file_search');
  ctx.toggleFileSearch();
}

function openShortcutsDialog(e: KeyboardEvent): void {
  if (isEditableTarget(e.target)) return;
  consume(e);
  log.info('shortcut.open_shortcuts');
  useUIStore.getState().toggleKeyboardShortcuts();
}

function walkThreadHistory(e: KeyboardEvent, ctx: ShortcutContext): void {
  if (isEditableTarget(e.target)) return;
  const history = useThreadHistoryStore.getState();
  const back = e.key === 'ArrowLeft';
  const entry = back ? history.goBack() : history.goForward();
  if (!entry) return;
  consume(e);
  log.info('shortcut.thread_history', { direction: back ? 'back' : 'forward' });
  ctx.navigate(buildPath(routeForHistoryEntry(entry)));
}

type ThreadState = ReturnType<typeof useThreadStore.getState>;
type SidebarThread = NonNullable<ThreadState['threadsById'][string]>;

/**
 * Match the sidebar's visible order + slice (see ProjectItem.tsx): pinned
 * first, then most-recent createdAt first, archived hidden, capped at the top
 * 5 visible rows so cycling stays within what the user actually sees.
 */
function visibleSidebarThreads(state: ThreadState, ids: string[]): SidebarThread[] {
  return ids
    .map((id) => state.threadsById[id])
    .filter((th): th is SidebarThread => !!th && !th.archived)
    .sort((a, b) => {
      if (a.pinned && !b.pinned) return -1;
      if (!a.pinned && b.pinned) return 1;
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    })
    .slice(0, 5);
}

function cycledThread(
  state: ThreadState,
  threads: SidebarThread[],
  delta: number,
): SidebarThread | undefined {
  // Prefer `selectedThreadId` over `activeThread?.id`: on rapid Alt+]/Alt+[
  // presses, `activeThread` is briefly null while the next thread loads,
  // but `selectedThreadId` is updated synchronously by `selectThread()`.
  // Without this, consecutive presses snapped to `threads[1]` /
  // `threads[length-1]` regardless of current position.
  const currentId = state.selectedThreadId ?? state.activeThread?.id ?? null;
  const currentIdx = currentId ? threads.findIndex((th) => th.id === currentId) : -1;
  const baseIdx = currentIdx >= 0 ? currentIdx : 0;
  const nextIdx = (baseIdx + delta + threads.length) % threads.length;
  return threads[nextIdx];
}

// Intentionally fires even when an editable element (e.g. the prompt input)
// has focus — after navigating to a new thread the prompt input auto-focuses,
// so requiring non-editable focus would make the second press a no-op.
function cycleProjectThreads(e: KeyboardEvent, ctx: ShortcutContext): void {
  const projectId = activeProjectId();
  if (!projectId) return;
  const state = useThreadStore.getState();
  const ids = state.threadIdsByProject[projectId] ?? [];
  if (ids.length < 2) return;
  const threads = visibleSidebarThreads(state, ids);
  if (threads.length < 2) return;
  const delta = e.key === ']' ? 1 : -1;
  const next = cycledThread(state, threads, delta);
  if (!next) return;
  consume(e);
  log.info('shortcut.thread_nav', { direction: delta > 0 ? 'next' : 'prev' });
  ctx.navigate(buildPath(`/projects/${projectId}/threads/${next.id}`));
}

function openProjectSettings(e: KeyboardEvent, ctx: ShortcutContext): void {
  consume(e);
  const projectId = activeProjectId();
  log.info('shortcut.project_settings', { projectId });
  ctx.navigate(
    buildPath(projectId ? `/projects/${projectId}/settings/general` : `/settings/general`),
  );
}

function startNewThread(e: KeyboardEvent, ctx: ShortcutContext): void {
  const projectId = activeProjectId();
  if (!projectId) return;
  consume(e);
  log.info('shortcut.new_thread', { projectId });
  useUIStore.getState().startNewThread(projectId);
  ctx.navigate(buildPath(`/projects/${projectId}`));
}

function startNewScratchThread(e: KeyboardEvent, ctx: ShortcutContext): void {
  consume(e);
  log.info('shortcut.new_scratch_thread');
  useUIStore.getState().startNewScratchThread();
  ctx.navigate(buildPath('/scratch/new'));
}

type UIState = ReturnType<typeof useUIStore.getState>;

const PANEL_TOGGLES: Record<string, (ui: UIState) => void> = {
  g: (ui) => {
    log.info('shortcut.toggle_review');
    ui.setReviewPaneOpen(!(ui.reviewPaneOpen && ui.rightPaneTab === 'review'));
  },
  f: (ui) => {
    log.info('shortcut.toggle_files');
    ui.setFilesPaneOpen(!(ui.reviewPaneOpen && ui.rightPaneTab === 'files'));
  },
  m: (ui) => {
    log.info('shortcut.toggle_comments');
    ui.setCommentsPaneOpen(!(ui.reviewPaneOpen && ui.rightPaneTab === 'comments'));
  },
  h: (ui) => {
    // Share is owner-only: the dialog mounts only when the header's Share
    // button is rendered. Gate on its presence so we never strand a stale
    // `shareDialogOpen` flag on a thread with no share dialog.
    if (document.querySelector('[data-testid="header-share-thread"]')) {
      log.info('shortcut.toggle_share');
      ui.toggleShareDialog();
    }
  },
};

function isPanelToggle(e: KeyboardEvent): boolean {
  return hasModifiers(e, ALT_ONLY) && Object.hasOwn(PANEL_TOGGLES, e.key.toLowerCase());
}

function togglePanel(e: KeyboardEvent): void {
  const ui = useUIStore.getState();
  consume(e);
  PANEL_TOGGLES[e.key.toLowerCase()](ui);
}

/** The active thread, falling back to the selected sidebar thread. */
function activeOrSelectedThread(): { id: string; projectId: string } | null {
  const threadState = useThreadStore.getState();
  if (threadState.activeThread) return threadState.activeThread;
  if (!threadState.selectedThreadId) return null;
  return threadState.threadsById[threadState.selectedThreadId] ?? null;
}

function threadListPath(): string {
  const activeThread = activeOrSelectedThread();
  const projectId = activeThread?.projectId ?? useProjectStore.getState().selectedProjectId;
  const params = new URLSearchParams();
  if (projectId) params.set('project', projectId);
  if (activeThread?.id && activeThread.projectId === projectId) {
    params.set('returnThread', activeThread.id);
  }
  const qs = params.toString();
  return qs ? `/list?${qs}` : '/list';
}

function openThreadList(e: KeyboardEvent, ctx: ShortcutContext): void {
  consume(e);
  ctx.navigate(buildPath(threadListPath()));
}

function firstTerminalCwd(scopeId: string, worktreePath: string | null | undefined): string {
  // Runner derives the actual cwd from `scratchThreadId`; this placeholder is
  // for display only.
  if (scopeId === SCRATCH_TERMINAL_SCOPE_ID) return '~';
  const { projects } = useProjectStore.getState();
  const project = projects.find((p: any) => p.id === scopeId);
  return worktreePath ?? project?.path ?? 'C:\\';
}

/**
 * Place the caret in the active terminal so the user can type immediately.
 * Hiding the panel unmounts the dockview terminal (xterm is destroyed +
 * removed from terminalRegistry), so on reopen the xterm is recreated
 * asynchronously (getXtermModules()). A single timed focus would race that
 * creation, so retry until the terminal is registered (capped), bailing if
 * the panel is hidden again or a modal dialog opens.
 */
function focusTerminalWhenReady(
  scopeId: string,
  activeId: string,
  scheduleFocus: ShortcutContext['scheduleFocus'],
): void {
  let tries = 0;
  const tryFocus = () => {
    if (!(useTerminalStore.getState().panelVisibleByProject[scopeId] ?? false)) return;
    if (document.querySelector('[role="dialog"][data-state="open"]')) return;
    const term = terminalRegistry.get(activeId);
    if (term) {
      term.focus();
      return;
    }
    if (tries++ < 30) scheduleFocus(tryFocus);
  };
  scheduleFocus(tryFocus);
}

function toggleTerminal(e: KeyboardEvent, ctx: ShortcutContext): void {
  e.preventDefault();
  log.info('shortcut.terminal_toggle');
  const store = useTerminalStore.getState();
  const { scopeId, scratchThreadId, worktreePath } = getTerminalScope();
  if (!scopeId) return;
  const scopeTabs = store.tabs.filter((t) => t.projectId === scopeId);
  const isVisible = store.panelVisibleByProject[scopeId] ?? false;
  if (scopeTabs.length === 0 && !isVisible) {
    store.addTab({
      id: crypto.randomUUID(),
      label: 'Terminal 1',
      cwd: firstTerminalCwd(scopeId, worktreePath),
      alive: true,
      projectId: scopeId,
      type: ctx.isTauri ? undefined : 'pty',
      scratchThreadId: scratchThreadId ?? undefined,
    });
    return;
  }
  store.togglePanel(scopeId);
  // Only focus when opening (not hiding) the panel.
  if (isVisible) return;
  const activeId = activeScopeTabId(store.activeTabId, scopeTabs);
  if (activeId) focusTerminalWhenReady(scopeId, activeId, ctx.scheduleFocus);
}

function activeScopeTabId(
  activeTabId: string | null,
  scopeTabs: TerminalTab[],
): string | undefined {
  if (activeTabId && scopeTabs.some((t) => t.id === activeTabId)) return activeTabId;
  return scopeTabs[scopeTabs.length - 1]?.id;
}

/**
 * Ordered shortcut table — the FIRST matching entry handles the event (even
 * when its action decides to bail without preventDefault), mirroring the
 * original if/return chain. Keep this order: e.g. Ctrl+Shift+P must resolve to
 * the command palette before Ctrl+P's file search is considered.
 */
const SHORTCUTS: readonly Shortcut[] = [
  {
    // Ctrl+K or Ctrl+Shift+P for command palette (toggle)
    name: 'command-palette',
    matches: (e) => isCtrlK(e) || isCtrlShiftP(e),
    run: openCommandPalette,
  },
  {
    // Ctrl+P for file search (toggle)
    name: 'file-search',
    matches: keyCombo({ ctrl: true, shift: false, alt: false }, 'p'),
    run: openFileSearch,
  },
  {
    // "?" to open keyboard shortcuts dialog (ignored when typing in inputs)
    name: 'shortcuts-dialog',
    matches: keyCombo({ ctrl: false, meta: false, alt: false }, '?'),
    run: openShortcutsDialog,
  },
  {
    // Alt+ArrowLeft / Alt+ArrowRight to walk through visited threads (browser-style)
    name: 'thread-history',
    matches: keyCombo(ALT_ONLY, 'ArrowLeft', 'ArrowRight'),
    run: walkThreadHistory,
  },
  {
    // Alt+] / Alt+[ to navigate threads in active project (next / previous)
    name: 'thread-nav',
    matches: keyCombo(ALT_ONLY, ']', '['),
    run: cycleProjectThreads,
  },
  {
    // Ctrl+, to open project settings (general page)
    name: 'project-settings',
    matches: keyCombo({ ctrl: true, shift: false, alt: false, meta: false }, ','),
    run: openProjectSettings,
  },
  {
    // Alt+N to start a new thread for the active project
    name: 'new-thread',
    matches: keyCombo(ALT_ONLY, 'n', 'N'),
    run: startNewThread,
  },
  {
    // Alt+S to start a new scratch thread (projectless)
    name: 'new-scratch-thread',
    matches: keyCombo(ALT_ONLY, 's', 'S'),
    run: startNewScratchThread,
  },
  {
    // Alt+G / Alt+F / Alt+H / Alt+M toggle the right-sidebar panels:
    //   Alt+G → commit (review/diff)    Alt+F → file manager (project files)
    //   Alt+H → share dialog            Alt+M → comments
    // preventDefault() also suppresses the macOS Option+letter typographic
    // glyphs and Chrome's Alt+F app-menu when the key is handled here.
    name: 'toggle-panel',
    matches: isPanelToggle,
    run: togglePanel,
  },
  {
    // Ctrl+Shift+L for thread list/search — scope to current thread's project
    // by default. (Was Ctrl+Shift+F until text-in-files search took that slot
    // to match the VSCode convention.)
    name: 'thread-list',
    matches: keyCombo({ ctrl: true, shift: true, alt: false }, 'L', 'l'),
    run: openThreadList,
  },
  {
    // Ctrl+` to toggle terminal
    name: 'terminal-toggle',
    matches: (e) => e.ctrlKey && (e.key === '`' || e.code === 'Backquote'),
    run: toggleTerminal,
  },
];

export function useGlobalShortcuts(
  toggleCommandPalette: () => void,
  toggleFileSearch: () => void,
  toggleTextSearch: () => void,
) {
  const navigate = useNavigate();

  useEffect(() => {
    const isTauri = !!(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__;
    const focusTimeouts = new Set<ReturnType<typeof setTimeout>>();
    const scheduleFocus = (callback: () => void) => {
      const timeout = setTimeout(() => {
        focusTimeouts.delete(timeout);
        callback();
      }, 60);
      focusTimeouts.add(timeout);
    };
    const ctx: ShortcutContext = {
      navigate,
      toggleCommandPalette,
      toggleFileSearch,
      isTauri,
      scheduleFocus,
    };

    const handler = (e: KeyboardEvent) => {
      SHORTCUTS.find((shortcut) => shortcut.matches(e))?.run(e, ctx);
    };
    window.addEventListener('keydown', handler);
    return () => {
      window.removeEventListener('keydown', handler);
      for (const timeout of focusTimeouts) clearTimeout(timeout);
      focusTimeouts.clear();
    };
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
