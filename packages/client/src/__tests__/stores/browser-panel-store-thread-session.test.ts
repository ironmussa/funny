/**
 * Thread-bound browser sessions in the panel store: the panel shares a
 * thread's session with its agent, detaches (never closes) it when the panel
 * closes or the user switches threads, and attaches when the agent opens one.
 */

import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  open: vi.fn(),
  close: vi.fn(),
  navigate: vi.fn(),
  urlThreadId: null as string | null,
}));

vi.mock('@/lib/browser-session-client', () => ({
  browserSessionClient: { open: mocks.open, close: mocks.close, navigate: mocks.navigate },
}));
vi.mock('@/lib/browser-session-frames', () => ({ clearLatestFrame: vi.fn() }));
vi.mock('@/stores/thread-store', () => ({ getUrlThreadId: () => mocks.urlThreadId }));

import { useBrowserPanelStore } from '@/stores/browser-panel-store';

const store = () => useBrowserPanelStore.getState();

describe('browser panel thread sessions', () => {
  beforeEach(() => {
    store().reset();
    mocks.open.mockClear();
    mocks.close.mockClear();
    mocks.urlThreadId = null;
  });

  test('opening a URL on a thread uses the thread session id', async () => {
    mocks.urlThreadId = 't1';
    await store().openBrowserSession('https://example.com');
    expect(store().sessionId).toBe('thread:t1');
    expect(store().sessionThreadId).toBe('t1');
    expect(mocks.open).toHaveBeenCalledWith('thread:t1', 'https://example.com');
  });

  test('opening a URL outside a thread uses a panel-owned id', async () => {
    await store().openBrowserSession('https://example.com');
    expect(store().sessionId).not.toMatch(/^thread:/);
    expect(store().sessionThreadId).toBeNull();
  });

  test('closing the panel detaches a thread session instead of closing it', async () => {
    mocks.urlThreadId = 't1';
    useBrowserPanelStore.setState({ open: true });
    await store().openBrowserSession('https://example.com');
    store().closePanel();
    await vi.waitFor(() => expect(mocks.close).toHaveBeenCalledWith('thread:t1', 'detach'));
  });

  test('closing the panel closes a panel-owned session', async () => {
    useBrowserPanelStore.setState({ open: true });
    await store().openBrowserSession('https://example.com');
    const id = store().sessionId;
    store().closePanel();
    await vi.waitFor(() => expect(mocks.close).toHaveBeenCalledWith(id, 'user'));
  });

  test('switching threads detaches the old session and probes the new one', async () => {
    useBrowserPanelStore.setState({ open: true });
    await store().attachThreadSession('t1');
    store().syncActiveThread('t2');
    await vi.waitFor(() => expect(mocks.open).toHaveBeenLastCalledWith('thread:t2', ''));
    expect(mocks.close).toHaveBeenCalledWith('thread:t1', 'detach');
    expect(store().sessionId).toBe('thread:t2');
  });

  test('not_found clears an attach attempt', async () => {
    useBrowserPanelStore.setState({ open: true });
    await store().attachThreadSession('t2');
    store().handleSessionNotFound('thread:t2');
    expect(store().sessionId).toBeNull();
    expect(store().sessionStatus).toBe('idle');
  });

  test('agent-opened on the active thread opens the panel and attaches', async () => {
    store().handleAgentOpened('thread:t1', 't1', 't1');
    await vi.waitFor(() => expect(mocks.open).toHaveBeenCalledWith('thread:t1', ''));
    expect(store().open).toBe(true);
    expect(store().sessionId).toBe('thread:t1');
  });

  test('agent-opened on another thread is ignored', () => {
    store().handleAgentOpened('thread:t1', 't1', 't9');
    expect(store().open).toBe(false);
    expect(store().sessionId).toBeNull();
  });

  test('viewport updates only apply to the current session', async () => {
    await store().attachThreadSession('t1');
    store().setSessionViewport('thread:other', 800, 600);
    expect(store().viewport).toEqual({ width: 1920, height: 1080 });
    store().setSessionViewport('thread:t1', 800, 600);
    expect(store().viewport).toEqual({ width: 800, height: 600 });
  });

  test('ending and clearing the profile send explicit close reasons', async () => {
    await store().attachThreadSession('t1');
    await store().endBrowserSession();
    expect(mocks.close).toHaveBeenCalledWith('thread:t1', 'user');
    await store().clearBrowserProfile();
    expect(mocks.close).toHaveBeenLastCalledWith('browser-profile', 'clear-profile');
  });
});
