/**
 * A browser session's record: its shape, a new record's defaults and its
 * panel CDP client. Split out of browser-session-manager.ts.
 */

import { EventEmitter } from 'events';

import type { ChromeSession } from '@funny/core/chrome';
import type { Dialog } from 'playwright';

import type {
  BrowserHost,
  BrowserProfileKind,
  BrowserTab,
} from '../browser-automation/browser-host.js';
import type { ViewportRecorder } from '../browser-automation/recorder.js';
import { RefGenerations } from '../browser-automation/snapshot-refs.js';

// Keep in sync with packages/client/src/lib/browser-session-viewport.ts
export const VIEWPORT_WIDTH = 1920;
export const VIEWPORT_HEIGHT = 1080;

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

export function newSessionRecord(init: {
  sessionId: string;
  userId: string;
  threadId: string | null;
  profile: BrowserProfileKind;
  url: string;
  host: BrowserHost;
  tab: BrowserTab;
  origin: 'panel' | 'agent';
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
