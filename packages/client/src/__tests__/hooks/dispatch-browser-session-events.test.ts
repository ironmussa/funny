import { afterEach, describe, expect, test, vi } from 'vitest';

const clientCalls = vi.hoisted(() => ({ close: vi.fn(), open: vi.fn() }));
vi.mock('@/lib/browser-session-client', () => ({ browserSessionClient: clientCalls }));

import {
  dispatchBrowserSessionEvent,
  recoverBrowserPanelSession,
} from '@/hooks/dispatch-browser-session-events';
import { useBrowserPanelStore } from '@/stores/browser-panel-store';

const SESSION = 'thread:t1';

function attachingTo(sessionId: string, fields: { url?: string; loadedUrl?: string | null } = {}) {
  useBrowserPanelStore.setState({
    sessionId,
    sessionStatus: 'spawning',
    url: fields.url ?? '',
    loadedUrl: fields.loadedUrl ?? null,
  });
}

afterEach(() => useBrowserPanelStore.getState().reset());

describe('browser-session:ready', () => {
  test('marks the attached session ready right away', () => {
    attachingTo(SESSION);
    dispatchBrowserSessionEvent('browser-session:ready', {
      sessionId: SESSION,
      url: 'https://example.com/',
      viewport: { width: 1280, height: 720 },
    });
    // Synchronous on purpose: no `import()` hop that could reach another store copy.
    const s = useBrowserPanelStore.getState();
    expect(s.sessionStatus).toBe('ready');
    expect(s.viewport).toEqual({ width: 1280, height: 720 });
  });

  test("shows the session's page, replacing a stale URL from before the attach", () => {
    attachingTo(SESSION, { url: 'http://localhost:5173', loadedUrl: 'http://localhost:5173' });
    dispatchBrowserSessionEvent('browser-session:ready', {
      sessionId: SESSION,
      url: 'https://example.com/',
    });
    const s = useBrowserPanelStore.getState();
    expect(s.url).toBe('https://example.com/');
    expect(s.loadedUrl).toBe('https://example.com/');
  });

  test('ignores another session', () => {
    attachingTo(SESSION);
    dispatchBrowserSessionEvent('browser-session:ready', { sessionId: 'thread:other', url: 'x' });
    expect(useBrowserPanelStore.getState().sessionStatus).toBe('spawning');
  });
});

describe('browser-session:navigated', () => {
  test('the URL bar follows the page', () => {
    attachingTo(SESSION, { url: 'https://a.test/', loadedUrl: 'https://a.test/' });
    dispatchBrowserSessionEvent('browser-session:navigated', {
      sessionId: SESSION,
      url: 'https://b.test/',
    });
    const s = useBrowserPanelStore.getState();
    expect(s.url).toBe('https://b.test/');
    expect(s.loadedUrl).toBe('https://b.test/');
  });

  test('keeps what the user is typing', () => {
    attachingTo(SESSION, { url: 'https://typ', loadedUrl: 'https://a.test/' });
    dispatchBrowserSessionEvent('browser-session:navigated', {
      sessionId: SESSION,
      url: 'https://b.test/',
    });
    const s = useBrowserPanelStore.getState();
    expect(s.url).toBe('https://typ');
    expect(s.loadedUrl).toBe('https://b.test/');
  });
});

describe('recoverBrowserPanelSession', () => {
  test("re-attaches the panel's thread session", () => {
    const attachThreadSession = vi.fn(async () => {});
    useBrowserPanelStore.setState({ sessionThreadId: 't1', attachThreadSession });
    recoverBrowserPanelSession();
    expect(attachThreadSession).toHaveBeenCalledWith('t1');
  });

  test('does nothing without a thread session', () => {
    const attachThreadSession = vi.fn(async () => {});
    useBrowserPanelStore.setState({ sessionThreadId: null, attachThreadSession });
    recoverBrowserPanelSession();
    expect(attachThreadSession).not.toHaveBeenCalled();
  });
});

describe('browser-session:closed', () => {
  test("the answer to the panel's own close does not end a session reopened since", async () => {
    attachingTo(SESSION);
    useBrowserPanelStore.setState({ sessionStatus: 'ready', sessionThreadId: 't1' });
    await useBrowserPanelStore.getState().endBrowserSession(); // sends close(SESSION, 'user')
    expect(clientCalls.close).toHaveBeenCalledWith(SESSION, 'user');

    // The thread's session is reopened (same id) before the runner's answer arrives.
    attachingTo(SESSION);
    dispatchBrowserSessionEvent('browser-session:closed', { sessionId: SESSION, reason: 'user' });

    expect(useBrowserPanelStore.getState().sessionStatus).toBe('spawning');
  });

  test('a close the panel did not send still ends the session', () => {
    attachingTo(SESSION);
    useBrowserPanelStore.setState({ sessionStatus: 'ready' });
    dispatchBrowserSessionEvent('browser-session:closed', { sessionId: SESSION, reason: 'user' });

    expect(useBrowserPanelStore.getState().sessionStatus).toBe('disconnected');
  });
});
