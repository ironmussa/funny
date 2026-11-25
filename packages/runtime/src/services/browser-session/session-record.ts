/**
 * The browser session record and its constants: what one session (one tab in
 * the user's Chromium) holds, and how a new one starts.
 */

import { EventEmitter } from 'events';

import type { ChromeSession } from '@funny/core/chrome';
import {
  cssSelector,
  detectFrameworkComponent,
  extractElementInfo,
  pickStyles,
} from '@funny/shared/dom/extract';
import type { Dialog } from 'playwright';

import type {
  BrowserHost,
  BrowserProfileKind,
  BrowserTab,
} from '../browser-automation/browser-host.js';
import type { ViewportRecorder } from '../browser-automation/recorder.js';
import { RefGenerations } from '../browser-automation/snapshot-refs.js';

export const NS = 'browser-session';
export const BASE_PORT = 9300; // test-runner uses 9223; keep us out of that range
export const MAX_SESSIONS = 8; // tabs per runner
export const HEARTBEAT_INTERVAL_MS = 30_000;
export const HEARTBEAT_TIMEOUT_MS = 90_000;
/** Thread-bound sessions with no agent call and no panel for this long close. */
export const THREAD_IDLE_TIMEOUT_MS = 15 * 60_000;
/** Keep Chromium warm briefly after its last tab closes. */
export const HOST_GRACE_MS = 30_000;
// Keep in sync with packages/client/src/lib/browser-session-viewport.ts
export const VIEWPORT_WIDTH = 1920;
export const VIEWPORT_HEIGHT = 1080;
export const MAX_CONSOLE_ERRORS = 20;

/**
 * Per-session inspect helpers — injected into Runtime.evaluate calls.
 *
 * Source of truth: `@funny/shared/dom/extract`. We serialize the TS functions
 * with `Function.prototype.toString()` (Bun strips type annotations, returning
 * post-transpile JS) and wrap them in an IIFE that exposes them as window
 * globals. The same code runs in the client (iframe path) via direct import —
 * eliminating drift between the two paths.
 */
export const INSPECT_HELPERS = `
(() => {
  if (window.__funnyInspectInstalled) return;
  window.__funnyInspectInstalled = true;
  ${cssSelector.toString()}
  ${pickStyles.toString()}
  ${detectFrameworkComponent.toString()}
  ${extractElementInfo.toString()}
  window.__funnyCssSelector = cssSelector;
  window.__funnyPickStyles = pickStyles;
  window.__funnyDetectFramework = detectFrameworkComponent;
  window.__funnyElementInfo = extractElementInfo;
})();
`.trim();

export type BrowserController = 'agent' | 'user';

/** A JavaScript dialog waiting for an answer from the agent or the user. */
export interface PendingDialog {
  type: string;
  message: string;
  defaultValue: string;
  dialog: Dialog;
}

export interface BrowserSession {
  sessionId: string;
  userId: string;
  /** Set for thread-bound sessions. */
  threadId: string | null;
  owner: 'panel' | 'thread';
  profile: BrowserProfileKind;
  url: string;
  host: BrowserHost;
  tab: BrowserTab;
  /** Background tabs left behind when the session followed a popup. */
  backgroundTabs: BrowserTab[];
  /** Panel-side CDP client; `null` only while (re)attaching or after close. */
  chromeSession: ChromeSession | null;
  viewport: { width: number; height: number };
  lastHeartbeat: number;
  panelAttached: boolean;
  lastAgentActivity: number;
  controller: BrowserController;
  /** Page audio is held muted until the user unmutes it (see `page-audio.ts`). */
  audioMuted: boolean;
  refs: RefGenerations;
  /** The open JavaScript dialog; the page is frozen until it is answered. */
  pendingDialog: PendingDialog | null;
  /** Active viewport recording, if any. */
  recorder: ViewportRecorder | null;
  /** Session-local signals (`dialog`) that in-flight agent actions wait on. */
  signals: EventEmitter;
  consoleErrors: string[];
  /** Serialises panel input and agent actions on this tab. */
  queue: Promise<unknown>;
}

export interface OpenSessionOptions {
  threadId?: string | null;
  profile?: BrowserProfileKind;
  origin: 'panel' | 'agent';
}

/** The JSON value CDP returns for a page evaluation (`returnByValue`). */
export type PageValue = Awaited<ReturnType<ChromeSession['execute']>>;

export function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function newSessionRecord(init: {
  sessionId: string;
  userId: string;
  threadId: string | null;
  profile: BrowserProfileKind;
  url: string;
  host: BrowserHost;
  tab: BrowserTab;
  origin: OpenSessionOptions['origin'];
}): BrowserSession {
  const now = Date.now();
  return {
    sessionId: init.sessionId,
    userId: init.userId,
    threadId: init.threadId,
    owner: init.threadId ? 'thread' : 'panel',
    profile: init.profile,
    url: init.url || 'about:blank',
    host: init.host,
    tab: init.tab,
    backgroundTabs: [],
    chromeSession: null,
    viewport: { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT },
    lastHeartbeat: now,
    panelAttached: init.origin === 'panel',
    lastAgentActivity: init.origin === 'agent' ? now : 0,
    controller: 'agent',
    audioMuted: true,
    refs: new RefGenerations(),
    pendingDialog: null,
    recorder: null,
    signals: new EventEmitter(),
    consoleErrors: [],
    queue: Promise.resolve(),
  };
}

/** The session's panel CDP client; a missing one means the session is gone. */
export function chromeOf(s: BrowserSession): ChromeSession {
  if (!s.chromeSession) throw new Error('no-session');
  return s.chromeSession;
}
