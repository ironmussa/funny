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
  type WSBrowserSessionConsoleData,
  type WSBrowserSessionNavigatedData,
  type WSBrowserSessionAgentActionData,
  type WSBrowserSessionPointerData,
} from '@funny/shared';

import {
  resolveBrowserSessionRequest,
  type BrowserSessionResult,
} from '@/lib/browser-session-client';
import { ingestBrowserSessionFrame } from '@/lib/browser-session-frames';
import { createClientLogger } from '@/lib/client-logger';
import type { BrowserSessionRealtimeEvent } from '@/lib/realtime/browser-session-v1-events';
import { useBrowserLiveThreadsStore } from '@/stores/browser-live-threads-store';
import { forgetOwnCloses, takeOwnClose, useBrowserPanelStore } from '@/stores/browser-panel-store';
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
  /** The id of the client close this answers (runners that echo it). */
  closeId?: string;
};

function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

function handleReady(d: BrowserSessionReadyData): void {
  // The browser.v1 `ready` carries no threadId: read it from the session id,
  // as `closed` does, or the sidebar globe never shows after a reload.
  const readyThreadId = d.threadId ?? threadIdFromBrowserSessionId(d.sessionId);
  if (readyThreadId) useBrowserLiveThreadsStore.getState().markOpen(readyThreadId);
  const store = useBrowserPanelStore.getState();
  if (store.sessionId !== d.sessionId) return;
  store.setSessionStatus('ready', null);
  if (d.viewport) store.setSessionViewport(d.sessionId, d.viewport.width, d.viewport.height);
  if (isBoolean(d.audioMuted)) store.setSessionAudio(d.sessionId, d.audioMuted);
  // Attaching to an existing session: show the page it is on.
  if (d.url) followSessionUrl(d.sessionId, d.url);
}

function handleClosed(d: BrowserSessionClosedData): void {
  log.info('session closed', d);
  const closedThreadId = d.threadId ?? threadIdFromBrowserSessionId(d.sessionId);
  if (closedThreadId) useBrowserLiveThreadsStore.getState().markClosed(closedThreadId);
  const store = useBrowserPanelStore.getState();
  if (d.reason === 'not_found') {
    forgetOwnCloses(d.sessionId);
    store.handleSessionNotFound(d.sessionId);
    return;
  }
  // The answer to a close this tab sent: the panel already shows it closed,
  // and may hold a new session under the same (per-thread) id by now.
  if (d.reason === 'user' && takeOwnClose(d.sessionId, d.closeId)) return;
  if (store.sessionId === d.sessionId) {
    const status = d.reason === 'too_many_sessions' ? 'too-many-sessions' : 'disconnected';
    store.setSessionStatus(status, d.message ?? null);
  }
}

/** One handler per inbound browser-session event type. */
const BROWSER_SESSION_HANDLERS = new Map<string, (data: any) => void>(
  Object.entries({
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

    'browser-session:agent-action': ({
      sessionId,
      threadId: _threadId,
      ...action
    }: WSBrowserSessionAgentActionData) =>
      useBrowserPointerStore.getState().setAction(sessionId, action),

    'browser-session:audio': (d: WSBrowserSessionAudioData) =>
      useBrowserPanelStore.getState().setSessionAudio(d.sessionId, d.muted),

    'browser-session:navigated': (d: WSBrowserSessionNavigatedData) =>
      followSessionUrl(d.sessionId, d.url),

    'browser-session:result': (d: {
      requestId: string;
      ok: boolean;
      value?: BrowserSessionResult;
      error?: string;
    }) => resolveBrowserSessionRequest(d.requestId, d.ok, d.value, d.error),

    // Visible only at debug log level — runner already emits the original.
    'browser-session:console': (d: WSBrowserSessionConsoleData) => log.debug('console', { ...d }),

    'browser-session:error': (d: { sessionId: string; message: string }) =>
      log.warn('page error', d),

    'browser-session:closed': handleClosed,
  } satisfies Record<string, (data: any) => void>),
);

export function dispatchBrowserSessionEvent(
  type: string,
  data: BrowserSessionRealtimeEvent['data'],
): boolean {
  const handle = BROWSER_SESSION_HANDLERS.get(type);
  if (!handle) return false;
  handle(data);
  return true;
}
