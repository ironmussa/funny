import {
  BrowserSessionController,
  BrowserSessionPointerKind,
  type BrowserSessionMessage,
} from '@funny/shared/browser-v1/interactive';

/** A browser-session event as the panel handlers expect it (`dispatchBrowserSessionEvent`). */
export interface BrowserSessionRealtimeEvent {
  type: `browser-session:${string}`;
  data: Record<string, unknown>;
}

function controllerName(value: BrowserSessionController): 'agent' | 'user' | undefined {
  if (value === BrowserSessionController.AGENT) return 'agent';
  if (value === BrowserSessionController.USER) return 'user';
  return undefined;
}

const POINTER_KINDS: Partial<Record<BrowserSessionPointerKind, string>> = {
  [BrowserSessionPointerKind.MOVE]: 'move',
  [BrowserSessionPointerKind.CLICK]: 'click',
  [BrowserSessionPointerKind.DOWN]: 'down',
  [BrowserSessionPointerKind.UP]: 'up',
};

type PayloadCase = NonNullable<BrowserSessionMessage['payload']['case']>;
type PayloadValue<C extends PayloadCase> = Extract<
  BrowserSessionMessage['payload'],
  { case: C }
>['value'];

function readyEvent(sessionId: string, ready: PayloadValue<'ready'>): BrowserSessionRealtimeEvent {
  const controller = controllerName(ready.controller);
  return {
    type: 'browser-session:ready',
    data: {
      sessionId,
      url: ready.targetUrl,
      ...(ready.viewport
        ? { viewport: { width: ready.viewport.width, height: ready.viewport.height } }
        : {}),
      ...(controller ? { controller } : {}),
      audioMuted: ready.audioMuted,
    },
  };
}

function controllerEvent(
  sessionId: string,
  value: PayloadValue<'controller'>,
): BrowserSessionRealtimeEvent | null {
  const controller = controllerName(value.controller);
  return controller
    ? { type: 'browser-session:controller', data: { sessionId, controller } }
    : null;
}

function dialogEvent(
  sessionId: string,
  value: PayloadValue<'dialog'>,
): BrowserSessionRealtimeEvent {
  const dialog = value.dialog;
  return {
    type: 'browser-session:dialog',
    data: {
      sessionId,
      dialog: dialog
        ? {
            type: dialog.type,
            message: dialog.message,
            ...(dialog.defaultValue !== undefined ? { defaultValue: dialog.defaultValue } : {}),
          }
        : null,
    },
  };
}

function pointerEvent(
  sessionId: string,
  value: PayloadValue<'pointer'>,
): BrowserSessionRealtimeEvent | null {
  const kind = POINTER_KINDS[value.kind];
  return kind
    ? { type: 'browser-session:pointer', data: { sessionId, x: value.x, y: value.y, kind } }
    : null;
}

function resultEvent(
  sessionId: string,
  value: PayloadValue<'result'>,
  requestId: string | undefined,
): BrowserSessionRealtimeEvent {
  const result = value.value ?? {};
  return {
    type: 'browser-session:result',
    data: {
      sessionId,
      requestId,
      ok: result.ok === true,
      value: result.value,
      error: typeof result.error === 'string' ? result.error : undefined,
    },
  };
}

function consoleEvent(
  sessionId: string,
  value: PayloadValue<'console'>,
): BrowserSessionRealtimeEvent {
  return {
    type: 'browser-session:console',
    data: {
      sessionId,
      level: value.level,
      text: value.text,
      url: value.url,
      line: value.line,
      column: value.column,
      timestamp: Number(value.occurredAtMs),
    },
  };
}

/**
 * Translate a `browser.v1` browser-session message into the panel's
 * `browser-session:*` event. Frames are not handled here: their bytes are
 * fetched from an authorized resource first. Returns null for payloads the
 * panel does not consume (client → server requests, unknown cases).
 */
export function browserSessionEventFromV1(
  browser: BrowserSessionMessage,
  requestId?: string,
): BrowserSessionRealtimeEvent | null {
  const sessionId = browser.browserSessionId;
  const payload = browser.payload;
  switch (payload.case) {
    case 'ready':
      return readyEvent(sessionId, payload.value);
    case 'viewport':
      return {
        type: 'browser-session:viewport',
        data: { sessionId, width: payload.value.width, height: payload.value.height },
      };
    case 'navigated':
      return { type: 'browser-session:navigated', data: { sessionId, url: payload.value.url } };
    case 'controller':
      return controllerEvent(sessionId, payload.value);
    case 'dialog':
      return dialogEvent(sessionId, payload.value);
    case 'agentOpened':
      return {
        type: 'browser-session:agent-opened',
        data: { sessionId, threadId: payload.value.threadId, url: payload.value.url },
      };
    case 'audio':
      return { type: 'browser-session:audio', data: { sessionId, muted: payload.value.muted } };
    case 'pointer':
      return pointerEvent(sessionId, payload.value);
    case 'result':
      return resultEvent(sessionId, payload.value, requestId);
    case 'status':
      return { type: 'browser-session:error', data: { sessionId, message: payload.value.message } };
    case 'close':
      return { type: 'browser-session:closed', data: { sessionId, reason: payload.value.reason } };
    case 'console':
      return consoleEvent(sessionId, payload.value);
    default:
      return null;
  }
}
