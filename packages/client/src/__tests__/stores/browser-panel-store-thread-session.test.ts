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
  input: vi.fn(),
  urlThreadId: null as string | null,
}));

vi.mock('@/lib/browser-session-client', () => ({
  browserSessionClient: {
    open: mocks.open,
    close: mocks.close,
    navigate: mocks.navigate,
    input: mocks.input,
  },
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
    mocks.input.mockClear();
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

  test('controller and dialog updates only apply to the current session', async () => {
    await store().attachThreadSession('t1');
    expect(store().controller).toBe('agent');
    store().setSessionController('thread:other', 'user');
    store().setSessionDialog('thread:other', { type: 'alert', message: 'x' });
    expect(store().controller).toBe('agent');
    expect(store().dialog).toBeNull();
    store().setSessionController('thread:t1', 'user');
    store().setSessionDialog('thread:t1', { type: 'confirm', message: 'Sure?' });
    expect(store().controller).toBe('user');
    expect(store().dialog).toEqual({ type: 'confirm', message: 'Sure?' });
  });

  test('taking over and handing back send control inputs', async () => {
    await store().attachThreadSession('t1');
    await store().setUserControl(true);
    expect(mocks.input).toHaveBeenLastCalledWith('thread:t1', { kind: 'takeControl' });
    await store().setUserControl(false);
    expect(mocks.input).toHaveBeenLastCalledWith('thread:t1', { kind: 'releaseControl' });
  });

  test('answering a dialog sends the answer and clears it', async () => {
    await store().attachThreadSession('t1');
    store().setSessionDialog('thread:t1', { type: 'prompt', message: 'Name?' });
    await store().answerDialog(true, 'Ada');
    expect(mocks.input).toHaveBeenCalledWith('thread:t1', {
      kind: 'dialog',
      accept: true,
      promptText: 'Ada',
    });
    expect(store().dialog).toBeNull();
  });

  test('switching sessions resets controller and dialog', async () => {
    await store().attachThreadSession('t1');
    store().setSessionController('thread:t1', 'user');
    store().setSessionDialog('thread:t1', { type: 'alert', message: 'Hi' });
    await store().attachThreadSession('t2');
    expect(store().controller).toBe('agent');
    expect(store().dialog).toBeNull();
  });
  test('annotation mode requires control and does not start on takeover', async () => {
    await store().attachThreadSession('t1');
    store().setSessionStatus('ready');
    store().setAnnotationMode(true);
    expect(store().annotationMode).toBe(false);
    store().setSessionController('thread:t1', 'user');
    expect(store().annotationMode).toBe(false);
    store().setAnnotationMode(true);
    expect(store().annotationMode).toBe(true);
  });

  test('handing back leaves annotation mode and preserves drafts', async () => {
    await store().attachThreadSession('t1');
    store().setSessionStatus('ready');
    store().setSessionController('thread:t1', 'user');
    store().setAnnotationMode(true);
    store().addAnnotation({ kind: 'draw', dataUrl: 'draft', color: '#ff0000', note: 'Keep this' });
    store().setTool('draw');
    store().toggleInspectActive();
    const drafts = store().annotations;
    await store().setUserControl(false);
    expect(store().annotationMode).toBe(false);
    expect(store().tool).toBe('browse');
    expect(store().inspectActive).toBe(false);
    expect(store().annotations).toEqual(drafts);
    store().setSessionController('thread:t1', 'agent');
    store().setSessionController('thread:t1', 'user');
    expect(store().annotationMode).toBe(false);
  });

  test('remote control changes exit annotation mode, unrelated updates do not', async () => {
    await store().attachThreadSession('t1');
    store().setSessionStatus('ready');
    store().setSessionController('thread:t1', 'user');
    store().setAnnotationMode(true);
    store().setSessionController('thread:other', 'agent');
    expect(store().annotationMode).toBe(true);
    store().setSessionController('thread:t1', 'agent');
    expect(store().annotationMode).toBe(false);
  });

  test('standalone sessions can annotate once ready and finish without deleting notes', async () => {
    await store().openBrowserSession('https://example.com');
    store().setAnnotationMode(true);
    expect(store().annotationMode).toBe(false);
    store().setSessionStatus('ready');
    store().setAnnotationMode(true);
    expect(store().annotationMode).toBe(true);
    store().addAnnotation({ kind: 'draw', dataUrl: 'draft', color: '#ff0000', note: 'Keep' });
    store().setAnnotationMode(false);
    expect(store().annotations).toHaveLength(1);
  });
});
