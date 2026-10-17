import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const { mockNavigate } = vi.hoisted(() => ({ mockNavigate: vi.fn() }));

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => mockNavigate };
});

import { useGlobalShortcuts } from '@/hooks/use-global-shortcuts';
import { useProjectStore } from '@/stores/project-store';
import { useThreadHistoryStore } from '@/stores/thread-history-store';
import { useThreadStore } from '@/stores/thread-store';
import { useUIStore } from '@/stores/ui-store';

function wrapper({ children }: { children: ReactNode }) {
  return <MemoryRouter>{children}</MemoryRouter>;
}

function renderShortcuts() {
  const toggleCommandPalette = vi.fn();
  const toggleFileSearch = vi.fn();
  const toggleTextSearch = vi.fn();
  renderHook(() => useGlobalShortcuts(toggleCommandPalette, toggleFileSearch, toggleTextSearch), {
    wrapper,
  });
  return { toggleCommandPalette, toggleFileSearch, toggleTextSearch };
}

function press(init: KeyboardEventInit, target: EventTarget = window): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { cancelable: true, bubbles: true, ...init });
  target.dispatchEvent(event);
  return event;
}

function thread(id: string, projectId: string, extra: Record<string, unknown> = {}) {
  return { id, projectId, createdAt: '2026-01-01T00:00:00Z', ...extra } as any;
}

describe('useGlobalShortcuts — shortcut table precedence and actions', () => {
  beforeEach(() => {
    mockNavigate.mockReset();
    useThreadStore.setState({
      activeThread: null,
      selectedThreadId: null,
      threadsById: {},
      threadIdsByProject: {},
    });
    useProjectStore.setState({ selectedProjectId: null });
    useThreadHistoryStore.getState().clear();
    useUIStore.setState({ keyboardShortcutsOpen: false });
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  test('Ctrl+K and Ctrl+Shift+P toggle the command palette (not file search)', () => {
    const { toggleCommandPalette, toggleFileSearch } = renderShortcuts();

    const k = press({ key: 'k', ctrlKey: true });
    const shiftP = press({ key: 'P', ctrlKey: true, shiftKey: true });

    expect(k.defaultPrevented).toBe(true);
    expect(shiftP.defaultPrevented).toBe(true);
    expect(toggleCommandPalette).toHaveBeenCalledTimes(2);
    expect(toggleFileSearch).not.toHaveBeenCalled();
  });

  test('Ctrl+P toggles file search', () => {
    const { toggleCommandPalette, toggleFileSearch } = renderShortcuts();
    const e = press({ key: 'p', ctrlKey: true });
    expect(e.defaultPrevented).toBe(true);
    expect(toggleFileSearch).toHaveBeenCalledTimes(1);
    expect(toggleCommandPalette).not.toHaveBeenCalled();
  });

  test('Ctrl+Alt+K matches nothing', () => {
    const { toggleCommandPalette } = renderShortcuts();
    const e = press({ key: 'k', ctrlKey: true, altKey: true });
    expect(e.defaultPrevented).toBe(false);
    expect(toggleCommandPalette).not.toHaveBeenCalled();
  });

  test('"?" opens the shortcuts dialog, but not while typing in an input', () => {
    renderShortcuts();

    const input = document.createElement('input');
    document.body.appendChild(input);
    const typed = press({ key: '?', shiftKey: true }, input);
    expect(typed.defaultPrevented).toBe(false);
    expect(useUIStore.getState().keyboardShortcutsOpen).toBe(false);

    const e = press({ key: '?', shiftKey: true });
    expect(e.defaultPrevented).toBe(true);
    expect(useUIStore.getState().keyboardShortcutsOpen).toBe(true);
  });

  test('Alt+ArrowLeft / Alt+ArrowRight walk thread history', () => {
    const history = useThreadHistoryStore.getState();
    history.pushThread({ threadId: 't1', projectId: 'p1' });
    history.pushThread({ threadId: 's1', projectId: '', isScratch: true });
    renderShortcuts();

    const back = press({ key: 'ArrowLeft', altKey: true });
    expect(back.defaultPrevented).toBe(true);
    expect(mockNavigate).toHaveBeenLastCalledWith('/projects/p1/threads/t1');

    press({ key: 'ArrowRight', altKey: true });
    expect(mockNavigate).toHaveBeenLastCalledWith('/scratch/s1');

    // Nothing further forward → not consumed.
    const noop = press({ key: 'ArrowRight', altKey: true });
    expect(noop.defaultPrevented).toBe(false);
    expect(mockNavigate).toHaveBeenCalledTimes(2);
  });

  test('Alt+] / Alt+[ cycle visible project threads, even from an input', () => {
    useThreadStore.setState({
      selectedThreadId: 'a',
      threadsById: {
        a: thread('a', 'p1', { createdAt: '2026-01-03T00:00:00Z' }),
        b: thread('b', 'p1', { createdAt: '2026-01-02T00:00:00Z' }),
        c: thread('c', 'p1', { createdAt: '2026-01-01T00:00:00Z', pinned: true }),
        z: thread('z', 'p1', { archived: true }),
      },
      threadIdsByProject: { p1: ['a', 'b', 'c', 'z'] },
    });
    useProjectStore.setState({ selectedProjectId: 'p1' });
    renderShortcuts();

    // Visible order: c (pinned), a, b.
    const input = document.createElement('input');
    document.body.appendChild(input);
    const next = press({ key: ']', altKey: true }, input);
    expect(next.defaultPrevented).toBe(true);
    expect(mockNavigate).toHaveBeenLastCalledWith('/projects/p1/threads/b');

    press({ key: '[', altKey: true });
    expect(mockNavigate).toHaveBeenLastCalledWith('/projects/p1/threads/c');
  });

  test('Alt+] is not consumed when the project has fewer than two threads', () => {
    useThreadStore.setState({
      threadsById: { a: thread('a', 'p1') },
      threadIdsByProject: { p1: ['a'] },
    });
    useProjectStore.setState({ selectedProjectId: 'p1' });
    renderShortcuts();

    const e = press({ key: ']', altKey: true });
    expect(e.defaultPrevented).toBe(false);
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  test('Ctrl+, opens project settings, or global settings without a project', () => {
    renderShortcuts();
    press({ key: ',', ctrlKey: true });
    expect(mockNavigate).toHaveBeenLastCalledWith('/settings/general');

    useThreadStore.setState({ activeThread: thread('t1', 'p9') });
    press({ key: ',', ctrlKey: true });
    expect(mockNavigate).toHaveBeenLastCalledWith('/projects/p9/settings/general');
  });

  test('Alt+N starts a new thread only when a project is active', () => {
    renderShortcuts();
    const none = press({ key: 'n', altKey: true });
    expect(none.defaultPrevented).toBe(false);
    expect(mockNavigate).not.toHaveBeenCalled();

    useProjectStore.setState({ selectedProjectId: 'p2' });
    const e = press({ key: 'N', altKey: true });
    expect(e.defaultPrevented).toBe(true);
    expect(useUIStore.getState().newThreadProjectId).toBe('p2');
    expect(mockNavigate).toHaveBeenLastCalledWith('/projects/p2');
  });

  test('Alt+S starts a new scratch thread', () => {
    renderShortcuts();
    const e = press({ key: 's', altKey: true });
    expect(e.defaultPrevented).toBe(true);
    expect(useUIStore.getState().newThreadIsScratch).toBe(true);
    expect(mockNavigate).toHaveBeenLastCalledWith('/scratch/new');
  });

  test('Alt+Shift+G does not toggle the review panel', () => {
    useUIStore.setState({ reviewPaneOpen: false });
    renderShortcuts();
    const e = press({ key: 'G', altKey: true, shiftKey: true });
    expect(e.defaultPrevented).toBe(false);
    expect(useUIStore.getState().reviewPaneOpen).toBe(false);
  });

  test('Ctrl+Shift+L opens the thread list scoped to the selected thread', () => {
    renderShortcuts();
    press({ key: 'L', ctrlKey: true, shiftKey: true });
    expect(mockNavigate).toHaveBeenLastCalledWith('/list');

    useThreadStore.setState({
      selectedThreadId: 't1',
      threadsById: { t1: thread('t1', 'p1') },
    });
    press({ key: 'l', ctrlKey: true, shiftKey: true });
    expect(mockNavigate).toHaveBeenLastCalledWith('/list?project=p1&returnThread=t1');
  });

  test('Ctrl+Shift+F toggles text search', () => {
    const { toggleTextSearch } = renderShortcuts();
    press({ key: 'F', code: 'KeyF', ctrlKey: true, shiftKey: true });
    expect(toggleTextSearch).toHaveBeenCalledTimes(1);
  });
});
