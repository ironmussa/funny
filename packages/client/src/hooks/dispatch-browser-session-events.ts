/**
 * Routes inbound browser-session WS events (frame / ready / result / console /
 * error / closed) to the panel store and the frame ingester. Kept in its own
 * file so the global `ws-event-dispatch.ts` doesn't carry these imports.
 *
 * The stores are imported statically, never with `import()`: after a hot
 * update a dynamic import can resolve to a second copy of the store, so
 * `ready` landed in a store no component reads and the panel stayed on
 * "Spawning Chrome…".
 */

import {
  threadIdFromBrowserSessionId,
  type WSBrowserSessionAudioData,
  type WSBrowserSessionNavigatedData,
  type WSBrowserSessionPointerData,
} from '@funny/shared';

import { resolveBrowserSessionRequest } from '@/lib/browser-session-client';
import { ingestBrowserSessionFrame } from '@/lib/browser-session-frames';
import { createClientLogger } from '@/lib/client-logger';
import { useBrowserLiveThreadsStore } from '@/stores/browser-live-threads-store';
import { useBrowserPanelStore } from '@/stores/browser-panel-store';
import { useBrowserPointerStore } from '@/stores/browser-pointer-store';
import { getUrlThreadId } from '@/stores/thread-store';

const log = createClientLogger('browser-session');

/**
 * Show the page the session is on. The URL bar text follows too, unless the
 * user is editing it (it differs from the loaded URL).
 */
function followSessionUrl(sessionId: string, url: string): void {
  const store = useBrowserPanelStore.getState();
  if (store.sessionId !== sessionId) return;
  const editing = !!store.url && store.url !== store.loadedUrl;
  useBrowserPanelStore.setState(editing ? { loadedUrl: url } : { url, loadedUrl: url });
}

/**
 * The server lost browser-session messages for this user (queue exhausted or
 * gap): re-attach the panel's thread session, whose `ready` restates its
 * whole state (page, viewport, controller, pending dialog).
 */
export function recoverBrowserPanelSession(): void {
  const { sessionThreadId, attachThreadSession } = useBrowserPanelStore.getState();
  if (!sessionThreadId) return;
  log.info('re-attaching browser session after resynchronization', { threadId: sessionThreadId });
  void attachThreadSession(sessionThreadId);
}

type BrowserSessionReadyData = {
  sessionId: string;
  url: string;
  viewport?: { width: number; height: number };
  audioMuted?: boolean;
  threadId?: string;
};

type BrowserSessionClosedData = {
  sessionId: string;
  reason: string;
  message?: string;
  threadId?: string;
};

function handleReady(d: BrowserSessionReadyData): void {
  if (d.threadId) useBrowserLiveThreadsStore.getState().markOpen(d.threadId);
  const store = useBrowserPanelStore.getState();
  if (store.sessionId !== d.sessionId) return;
  store.setSessionStatus('ready', null);
  if (d.viewport) store.setSessionViewport(d.sessionId, d.viewport.width, d.viewport.height);
  if (typeof d.audioMuted === 'boolean') store.setSessionAudio(d.sessionId, d.audioMuted);
  // Attaching to an existing session: show the page it is on.
  if (d.url) followSessionUrl(d.sessionId, d.url);
}

function handleClosed(d: BrowserSessionClosedData): void {
  log.info('session closed', d);
  const closedThreadId = d.threadId ?? threadIdFromBrowserSessionId(d.sessionId);
  if (closedThreadId) useBrowserLiveThreadsStore.getState().markClosed(closedThreadId);
  const store = useBrowserPanelStore.getState();
  if (d.reason === 'not_found') {
    store.handleSessionNotFound(d.sessionId);
    return;
  }
  if (store.sessionId === d.sessionId) {
    const status = d.reason === 'too_many_sessions' ? 'too-many-sessions' : 'disconnected';
    store.setSessionStatus(status, d.message ?? null);
  }
}

/** One handler per inbound browser-session event type. */
const BROWSER_SESSION_HANDLERS: Record<string, (data: any) => void> = {
  'browser-session:frame': (d: { sessionId: string; data: string }) =>
    ingestBrowserSessionFrame(d.sessionId, d.data),

  'browser-session:ready': handleReady,

  'browser-session:agent-opened': (d: { sessionId: string; threadId: string; url: string }) => {
    useBrowserLiveThreadsStore.getState().markOpen(d.threadId);
    useBrowserPanelStore.getState().handleAgentOpened(d.sessionId, d.threadId, getUrlThreadId());
  },

  'browser-session:controller': (d: { sessionId: string; controller: 'agent' | 'user' }) =>
    useBrowserPanelStore.getState().setSessionController(d.sessionId, d.controller),

  'browser-session:dialog': (d: {
    sessionId: string;
    dialog: { type: string; message: string; defaultValue?: string } | null;
  }) => useBrowserPanelStore.getState().setSessionDialog(d.sessionId, d.dialog),

  'browser-session:viewport': (d: { sessionId: string; width: number; height: number }) =>
    useBrowserPanelStore.getState().setSessionViewport(d.sessionId, d.width, d.height),

  'browser-session:pointer': (d: WSBrowserSessionPointerData) =>
    useBrowserPointerStore.getState().setPointer(d.sessionId, { x: d.x, y: d.y, kind: d.kind }),

  'browser-session:audio': (d: WSBrowserSessionAudioData) =>
    useBrowserPanelStore.getState().setSessionAudio(d.sessionId, d.muted),

  'browser-session:navigated': (d: WSBrowserSessionNavigatedData) =>
    followSessionUrl(d.sessionId, d.url),

  'browser-session:result': (d: {
    requestId: string;
    ok: boolean;
    value?: unknown;
    error?: string;
  }) => resolveBrowserSessionRequest(d.requestId, d.ok, d.value, d.error),

  // Visible only at debug log level — runner already emits the original.
  'browser-session:console': (d: Record<string, unknown>) => log.debug('console', d),

  'browser-session:error': (d: { sessionId: string; message: string }) => log.warn('page error', d),

  'browser-session:closed': handleClosed,
};

export function dispatchBrowserSessionEvent(type: string, data: unknown): boolean {
  if (!Object.hasOwn(BROWSER_SESSION_HANDLERS, type)) return false;
  BROWSER_SESSION_HANDLERS[type](data);
  return true;
}
