/**
 * Runner-side browser session manager — shared by the Browser Panel and the
 * agent's browser tools.
 *
 * Each user gets one headless Chromium (`BrowserHost`) on a persistent
 * profile; each session is one tab in it. The panel streams and drives a tab
 * through a `ChromeSession` (CDP screencast + input) attached to the tab's
 * target id, while the agent drives the same tab through Playwright. A session
 * is either:
 *
 *   - panel-owned — opened from the panel with a random id; closes with the
 *     panel or after the heartbeat times out;
 *   - thread-bound — id `thread:<threadId>`, opened by the agent or by the
 *     panel on a thread; survives panel close and agent turns, and closes on
 *     explicit close, idle timeout, thread deletion or runner shutdown.
 *
 * Runtime log level override:
 *   __funnyLog.setNamespaceLevel('browser-session', 'debug')
 */

import { readdir, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import type { ChromeSession } from '@funny/core/chrome';
import type {
  BrowserSessionClosedReason,
  WSBrowserSessionInputData,
  WSBrowserSessionResultData,
} from '@funny/shared';
import { threadBrowserSessionId, threadIdFromBrowserSessionId } from '@funny/shared';
import {
  cssSelector,
  detectFrameworkComponent,
  extractElementInfo,
  pickStyles,
} from '@funny/shared/dom/extract';
import type { Page } from 'playwright';

import { log } from '../lib/logger.js';
import { metric, startSpan } from '../lib/telemetry.js';
import {
  BrowserHost,
  profileDirFor,
  resolveChromiumBinary,
  type BrowserProfileKind,
  type BrowserTab,
} from './browser-automation/browser-host.js';
import { RefGenerations } from './browser-automation/snapshot-refs.js';
import { shutdownManager, ShutdownPhase } from './shutdown-manager.js';
import { wsBroker } from './ws-broker.js';

const NS = 'browser-session';
const BASE_PORT = 9300; // test-runner uses 9223; keep us out of that range
const MAX_SESSIONS = 8; // tabs per runner
const HEARTBEAT_INTERVAL_MS = 30_000;
const HEARTBEAT_TIMEOUT_MS = 90_000;
/** Thread-bound sessions with no agent call and no panel for this long close. */
const THREAD_IDLE_TIMEOUT_MS = 15 * 60_000;
/** Keep Chromium warm briefly after its last tab closes. */
const HOST_GRACE_MS = 30_000;
// Keep in sync with packages/client/src/lib/browser-session-viewport.ts
const VIEWPORT_WIDTH = 1920;
const VIEWPORT_HEIGHT = 1080;
const MAX_CONSOLE_ERRORS = 20;

/**
 * Per-session inspect helpers — injected into Runtime.evaluate calls.
 *
 * Source of truth: `@funny/shared/dom/extract`. We serialize the TS functions
 * with `Function.prototype.toString()` (Bun strips type annotations, returning
 * post-transpile JS) and wrap them in an IIFE that exposes them as window
 * globals. The same code runs in the client (iframe path) via direct import —
 * eliminating drift between the two paths.
 */
const INSPECT_HELPERS = `
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

export interface BrowserDialogRecord {
  type: string;
  message: string;
  handled: 'dismissed' | 'accepted';
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
  refs: RefGenerations;
  /** Dialogs auto-handled since the agent last looked (reported once). */
  pendingDialogReports: BrowserDialogRecord[];
  consoleErrors: string[];
  /** Serialises panel input and agent actions on this tab. */
  queue: Promise<unknown>;
}

interface OpenSessionOptions {
  threadId?: string | null;
  profile?: BrowserProfileKind;
  origin: 'panel' | 'agent';
}

interface HostEntry {
  host: BrowserHost | null;
  launching: Promise<BrowserHost> | null;
  graceTimer: ReturnType<typeof setTimeout> | null;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function newSessionRecord(init: {
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
    refs: new RefGenerations(),
    pendingDialogReports: [],
    consoleErrors: [],
    queue: Promise.resolve(),
  };
}

/** The session's panel CDP client; a missing one means the session is gone. */
function chromeOf(s: BrowserSession): ChromeSession {
  if (!s.chromeSession) throw new Error('no-session');
  return s.chromeSession;
}

type MouseButton = 'left' | 'middle' | 'right';
type PanelInputHandler = (cs: ChromeSession, input: WSBrowserSessionInputData) => Promise<void>;

function mouse(type: 'mouseMoved' | 'mousePressed' | 'mouseReleased'): PanelInputHandler {
  return (cs, input) =>
    cs.dispatchMouseEvent({
      type,
      x: input.x ?? 0,
      y: input.y ?? 0,
      ...(type === 'mouseMoved'
        ? {}
        : { button: (input.button ?? 'left') as MouseButton, clickCount: input.clickCount ?? 1 }),
    });
}

function key(type: 'keyDown' | 'keyUp'): PanelInputHandler {
  return (cs, input) =>
    cs.dispatchKeyEvent({
      type,
      key: input.key ?? '',
      code: input.code ?? '',
      // Only keyDown carries the typed character.
      text: type === 'keyDown' ? input.text : undefined,
      modifiers: input.modifiers ?? 0,
    });
}

/** Panel input event → CDP dispatch on the session's tab. */
const PANEL_INPUT: Record<WSBrowserSessionInputData['kind'], PanelInputHandler> = {
  mouseMove: mouse('mouseMoved'),
  mouseDown: mouse('mousePressed'),
  mouseUp: mouse('mouseReleased'),
  wheel: (cs, input) =>
    cs.dispatchScroll(input.x ?? 0, input.y ?? 0, input.deltaX ?? 0, input.deltaY ?? 0),
  keyDown: key('keyDown'),
  keyUp: key('keyUp'),
};

class BrowserSessionManager {
  private sessions = new Map<string, BrowserSession>();
  private hosts = new Map<string, HostEntry>();
  private reaperTimer: ReturnType<typeof setInterval> | null = null;

  private emit(
    s: { userId: string; threadId: string | null },
    type: string,
    data: Record<string, unknown>,
  ): void {
    // The envelope keeps `threadId: ''` (browser-session events are user-scoped);
    // the thread binding travels inside `data` for the panel to route on.
    wsBroker.emitToUser(s.userId, {
      type,
      threadId: '',
      data: s.threadId ? { ...data, threadId: s.threadId } : data,
    } as any);
  }

  /**
   * `ready` plus a separate `viewport` event: the `browser.v1` ready payload
   * only carries the URL, so the viewport must also travel on its own.
   */
  private emitReady(s: BrowserSession): void {
    this.emit(s, 'browser-session:ready', {
      sessionId: s.sessionId,
      url: s.url,
      viewport: s.viewport,
    });
    this.emit(s, 'browser-session:viewport', { sessionId: s.sessionId, ...s.viewport });
  }

  private startReaper() {
    if (this.reaperTimer) return;
    this.reaperTimer = setInterval(() => this.reap(Date.now()), HEARTBEAT_INTERVAL_MS);
    this.reaperTimer.unref?.();
  }

  /** Heartbeat + idle sweep. Exposed for tests via `reap(now)`. */
  reap(now: number): void {
    for (const s of this.sessions.values()) {
      const heartbeatLost = now - s.lastHeartbeat > HEARTBEAT_TIMEOUT_MS;
      if (s.owner === 'panel') {
        if (heartbeatLost) {
          log.warn('Reaping idle browser session', {
            namespace: NS,
            sessionId: s.sessionId,
            idleMs: now - s.lastHeartbeat,
          });
          this.closeAndLog(s.sessionId, 'heartbeat');
        }
        continue;
      }
      if (s.panelAttached && heartbeatLost) {
        log.info('Panel heartbeat lost; detaching thread session', {
          namespace: NS,
          sessionId: s.sessionId,
        });
        s.panelAttached = false;
      }
      const lastUse = Math.max(s.lastAgentActivity, s.lastHeartbeat);
      if (!s.panelAttached && now - lastUse > THREAD_IDLE_TIMEOUT_MS) {
        log.info('Closing idle thread browser session', { namespace: NS, sessionId: s.sessionId });
        this.closeAndLog(s.sessionId, 'idle');
      }
    }
  }

  private stopReaperIfIdle() {
    if (this.sessions.size === 0 && this.reaperTimer) {
      clearInterval(this.reaperTimer);
      this.reaperTimer = null;
    }
  }

  // ── Hosts ────────────────────────────────────────────────────────────────

  private async allocatePort(): Promise<number> {
    const { findAvailablePort } = await import('@funny/core/ports');
    const used = new Set<number>();
    for (const entry of this.hosts.values()) if (entry.host) used.add(entry.host.port);
    return findAvailablePort(BASE_PORT, used);
  }

  /** The user's Chromium host, launching it if needed (concurrent callers share one launch). */
  private async hostFor(userId: string): Promise<BrowserHost> {
    let entry = this.hosts.get(userId);
    if (!entry) {
      entry = { host: null, launching: null, graceTimer: null };
      this.hosts.set(userId, entry);
    }
    if (entry.graceTimer) {
      clearTimeout(entry.graceTimer);
      entry.graceTimer = null;
    }
    if (entry.host?.alive) return entry.host;
    if (entry.launching) return entry.launching;

    const launching = (async () => {
      const binary = await resolveChromiumBinary();
      const port = await this.allocatePort();
      const result = await BrowserHost.launch({
        binary,
        port,
        profileDir: profileDirFor(userId),
        windowWidth: VIEWPORT_WIDTH,
        windowHeight: VIEWPORT_HEIGHT,
        onExit: (detail) => this.onHostExit(userId, detail),
      });
      if (result.isErr()) throw result.error;
      return result.value;
    })();
    entry.launching = launching;
    try {
      const host = await launching;
      entry.host = host;
      return host;
    } finally {
      entry.launching = null;
    }
  }

  private onHostExit(userId: string, detail: string): void {
    const entry = this.hosts.get(userId);
    if (entry) entry.host = null;
    for (const s of this.sessions.values()) {
      if (s.userId === userId) {
        log.warn('Chromium host died; closing session', {
          namespace: NS,
          sessionId: s.sessionId,
          detail,
        });
        this.closeAndLog(s.sessionId, 'error');
      }
    }
  }

  private scheduleHostShutdownIfUnused(userId: string): void {
    const entry = this.hosts.get(userId);
    if (!entry?.host) return;
    const inUse = Array.from(this.sessions.values()).some((s) => s.userId === userId);
    if (inUse || entry.graceTimer) return;
    entry.graceTimer = setTimeout(() => {
      entry.graceTimer = null;
      const stillUnused = !Array.from(this.sessions.values()).some((s) => s.userId === userId);
      if (stillUnused && entry.host) {
        const host = entry.host;
        entry.host = null;
        void host.shutdown();
      }
    }, HOST_GRACE_MS);
    entry.graceTimer.unref?.();
  }

  // ── Lookup / ownership ───────────────────────────────────────────────────

  /** A session the given user owns, or `null` (foreign or missing ids look the same). */
  getOwned(userId: string, sessionId: string): BrowserSession | null {
    const s = this.sessions.get(sessionId);
    if (!s) return null;
    if (s.userId !== userId) {
      log.warn('Refusing browser session owned by another user', {
        namespace: NS,
        sessionId,
        userId,
      });
      return null;
    }
    return s;
  }

  private requireOwned(userId: string, sessionId: string): BrowserSession {
    const s = this.getOwned(userId, sessionId);
    if (!s) throw new Error('no-session');
    return s;
  }

  findByThread(userId: string, threadId: string): BrowserSession | null {
    return this.getOwned(userId, threadBrowserSessionId(threadId));
  }

  /** Threads currently holding a session (for the `too-many-sessions` message). */
  listThreadsWithSessions(userId: string): string[] {
    return Array.from(this.sessions.values())
      .filter((s) => s.userId === userId && s.threadId)
      .map((s) => s.threadId as string);
  }

  // ── Open ─────────────────────────────────────────────────────────────────

  /**
   * Open (or reuse) a session. From the panel, an empty `url` is an attach
   * attempt: it re-attaches to an existing session and never creates one.
   */
  async open(
    userId: string,
    sessionId: string,
    url: string,
    opts: OpenSessionOptions = { origin: 'panel' },
  ): Promise<BrowserSession | null> {
    log.info('open() called', { namespace: NS, sessionId, userId, url, origin: opts.origin });
    const threadId = opts.threadId ?? threadIdFromBrowserSessionId(sessionId);

    const existing = this.sessions.get(sessionId);
    if (existing) return this.reuseSession(existing, userId, url, opts.origin);

    if (!url && opts.origin === 'panel') {
      this.emit({ userId, threadId }, 'browser-session:closed', { sessionId, reason: 'not_found' });
      return null;
    }
    this.ensureCapacity(userId, sessionId, threadId);

    const profile = opts.profile ?? 'persistent';
    const { host, tab } = await this.openTab(userId, sessionId, threadId, profile);
    const session = newSessionRecord({
      sessionId,
      userId,
      threadId,
      profile,
      url,
      host,
      tab,
      origin: opts.origin,
    });
    // Register before connecting so a concurrent open for the same id reuses it.
    this.sessions.set(sessionId, session);
    this.startReaper();
    await this.startSession(session, url);

    metric('browser_session.opened', 1, { type: 'sum', attributes: { origin: opts.origin } });
    log.info('Browser session ready', { namespace: NS, sessionId, threadId, profile });
    this.emitReady(session);
    if (opts.origin === 'agent' && threadId) {
      this.emit(session, 'browser-session:agent-opened', { sessionId, url: session.url });
    }
    return session;
  }

  /** Open on an id that already has a session: navigate and (re)attach. */
  private async reuseSession(
    existing: BrowserSession,
    userId: string,
    url: string,
    origin: OpenSessionOptions['origin'],
  ): Promise<BrowserSession> {
    if (existing.userId !== userId) {
      log.warn('Refusing open for a session owned by another user', {
        namespace: NS,
        sessionId: existing.sessionId,
      });
      throw new Error('no-session');
    }
    if (url) await this.navigate(userId, existing.sessionId, url);
    if (origin === 'panel') {
      existing.panelAttached = true;
      existing.lastHeartbeat = Date.now();
      this.emitReady(existing);
      return existing;
    }
    existing.lastAgentActivity = Date.now();
    if (url && existing.threadId) {
      this.emit(existing, 'browser-session:agent-opened', {
        sessionId: existing.sessionId,
        url: existing.url,
      });
    }
    return existing;
  }

  private ensureCapacity(userId: string, sessionId: string, threadId: string | null): void {
    if (this.sessions.size < MAX_SESSIONS) return;
    log.warn('Too many sessions, refusing open', {
      namespace: NS,
      sessionId,
      active: this.sessions.size,
    });
    this.emit({ userId, threadId }, 'browser-session:closed', {
      sessionId,
      reason: 'too_many_sessions',
    });
    throw new Error('too-many-sessions');
  }

  /** Launch (or reuse) the user's Chromium and open a tab in it. */
  private async openTab(
    userId: string,
    sessionId: string,
    threadId: string | null,
    profile: BrowserProfileKind,
  ): Promise<{ host: BrowserHost; tab: BrowserTab }> {
    try {
      const host = await this.hostFor(userId);
      const tabResult = await host.newTab(profile);
      if (tabResult.isErr()) throw tabResult.error;
      return { host, tab: tabResult.value };
    } catch (err) {
      const msg = errorMessage(err);
      log.error('Could not open browser tab', { namespace: NS, sessionId, error: msg });
      this.emit({ userId, threadId }, 'browser-session:closed', {
        sessionId,
        reason: 'error',
        message: msg,
      });
      this.scheduleHostShutdownIfUnused(userId);
      throw err;
    }
  }

  /** Attach the panel client, watch the page and load the first URL; closes on failure. */
  private async startSession(session: BrowserSession, url: string): Promise<void> {
    try {
      await this.attachChromeSession(session, session.tab.targetId);
      this.watchPage(session, session.tab.page);
      if (url) await chromeOf(session).navigate(url);
      await chromeOf(session)
        .execute(INSPECT_HELPERS)
        .catch((err: unknown) => {
          log.warn('Failed to install inspect helpers', {
            namespace: NS,
            sessionId: session.sessionId,
            error: String(err),
          });
        });
    } catch (err) {
      log.error('Browser session failed to start', {
        namespace: NS,
        sessionId: session.sessionId,
        error: String(err),
      });
      await this.close(session.sessionId, 'error');
      throw err;
    }
  }

  /** Thread-bound open for the agent tools. */
  openForThread(
    userId: string,
    threadId: string,
    url: string,
    profile: BrowserProfileKind = 'persistent',
  ): Promise<BrowserSession | null> {
    return this.open(userId, threadBrowserSessionId(threadId), url, {
      threadId,
      profile,
      origin: 'agent',
    });
  }

  /** Connect the panel-side CDP client (screencast, input) to a tab. */
  private async attachChromeSession(s: BrowserSession, targetId: string): Promise<void> {
    const { ChromeSession } = await import('@funny/core/chrome');
    const chromeSession = new ChromeSession({
      host: '127.0.0.1',
      port: s.host.port,
      targetId,
      format: 'jpeg',
      quality: 60,
      maxWidth: VIEWPORT_WIDTH,
      maxHeight: VIEWPORT_HEIGHT,
      everyNthFrame: 1,
    });

    // Wire events BEFORE connect so we don't miss the early frames.
    chromeSession.on('frame', (frame: { data: string; timestamp: number }) => {
      if (s.chromeSession !== chromeSession) return;
      this.emit(s, 'browser-session:frame', {
        sessionId: s.sessionId,
        data: frame.data,
        timestamp: frame.timestamp,
      });
    });
    chromeSession.on('console', (entry: Record<string, unknown>) => {
      if (s.chromeSession !== chromeSession) return;
      this.emit(s, 'browser-session:console', { sessionId: s.sessionId, ...entry });
    });
    chromeSession.on('error', (err: { message: string } & Record<string, unknown>) => {
      if (s.chromeSession !== chromeSession) return;
      this.emit(s, 'browser-session:error', { sessionId: s.sessionId, ...err });
    });
    chromeSession.on('disconnect', () => {
      // A deliberate re-attach (popup switch) replaces `s.chromeSession` first.
      if (s.chromeSession !== chromeSession) return;
      // A popup that closed itself (OAuth windows do) drops its target: go
      // back to the opener. Give Playwright a moment to observe the close.
      setTimeout(() => {
        if (s.chromeSession !== chromeSession || this.sessions.get(s.sessionId) !== s) return;
        if (s.tab.page.isClosed() && s.backgroundTabs.length > 0) {
          void this.restorePreviousTab(s);
          return;
        }
        log.warn('Chrome disconnected', { namespace: NS, sessionId: s.sessionId });
        this.closeAndLog(s.sessionId, 'error');
      }, 250);
    });

    const previous = s.chromeSession;
    s.chromeSession = chromeSession;
    await chromeSession.connect();
    // Lock the page viewport so the screencast frame size matches the
    // coordinate space the client uses to translate clicks.
    await chromeSession.setViewport(s.viewport.width, s.viewport.height).catch((err: unknown) => {
      log.warn('Failed to set viewport', {
        namespace: NS,
        sessionId: s.sessionId,
        error: String(err),
      });
    });
    if (previous) await previous.disconnect().catch(() => {});
  }

  /** Playwright-side listeners: navigation invalidates refs, dialogs, popups, errors. */
  private watchPage(s: BrowserSession, page: Page): void {
    page.on('framenavigated', (frame) => {
      if (s.tab.page !== page || frame !== page.mainFrame()) return;
      s.url = frame.url();
      s.refs.invalidate('navigation');
    });
    page.on('dialog', (dialog) => {
      if (s.tab.page !== page) return;
      // Phase 1: no agent-facing dialog tool yet — dismiss and report.
      s.pendingDialogReports.push({
        type: dialog.type(),
        message: dialog.message(),
        handled: 'dismissed',
      });
      void dialog.dismiss().catch(() => {});
    });
    page.on('console', (msg) => {
      if (s.tab.page !== page || msg.type() !== 'error') return;
      s.consoleErrors.push(msg.text().slice(0, 500));
      if (s.consoleErrors.length > MAX_CONSOLE_ERRORS) s.consoleErrors.shift();
    });
    page.on('pageerror', (error) => {
      if (s.tab.page !== page) return;
      s.consoleErrors.push(error.message.slice(0, 500));
      if (s.consoleErrors.length > MAX_CONSOLE_ERRORS) s.consoleErrors.shift();
    });
    page.on('close', () => {
      if (s.tab.page === page && s.backgroundTabs.length > 0) void this.restorePreviousTab(s);
    });
    page.on('popup', (popup) => {
      if (s.tab.page !== page) return;
      void this.followPopup(s, popup).catch((err) => {
        log.warn('Could not follow popup', {
          namespace: NS,
          sessionId: s.sessionId,
          error: String(err),
        });
      });
    });
  }

  /** Keep one active tab per session: switch the session (and panel) to a popup. */
  private async followPopup(s: BrowserSession, popup: Page): Promise<void> {
    const cdp = await popup.context().newCDPSession(popup);
    const info = (await cdp.send('Target.getTargetInfo')) as { targetInfo: { targetId: string } };
    await cdp.detach().catch(() => {});
    s.backgroundTabs.push(s.tab);
    s.tab = { page: popup, targetId: info.targetInfo.targetId, ephemeralContext: null };
    s.refs.invalidate('navigation');
    s.url = popup.url();
    this.watchPage(s, popup);
    await this.attachChromeSession(s, info.targetInfo.targetId);
    log.info('Session followed popup', { namespace: NS, sessionId: s.sessionId, url: s.url });
  }

  /** The active tab closed: switch back to the most recent open background tab. */
  private async restorePreviousTab(s: BrowserSession): Promise<void> {
    if (!s.tab.page.isClosed()) return;
    let previous = s.backgroundTabs.pop();
    while (previous && previous.page.isClosed()) previous = s.backgroundTabs.pop();
    if (!previous) {
      this.closeAndLog(s.sessionId, 'error');
      return;
    }
    s.tab = previous;
    s.url = previous.page.url();
    s.refs.invalidate('navigation');
    try {
      await this.attachChromeSession(s, previous.targetId);
      log.info('Session returned to previous tab', { namespace: NS, sessionId: s.sessionId });
    } catch (err) {
      log.warn('Could not return to previous tab', {
        namespace: NS,
        sessionId: s.sessionId,
        error: String(err),
      });
      this.closeAndLog(s.sessionId, 'error');
    }
  }

  // ── Panel operations (all ownership-checked) ─────────────────────────────

  async navigate(userId: string, sessionId: string, url: string): Promise<void> {
    const s = this.requireOwned(userId, sessionId);
    await chromeOf(s).navigate(url);
    // Re-install helpers in case of full reload.
    await chromeOf(s)
      .execute(INSPECT_HELPERS)
      .catch(() => {});
    s.url = url;
    s.lastHeartbeat = Date.now();
  }

  /**
   * Page-level back / forward / reload via CDP `Page` domain. Used by the URL
   * bar instead of `Runtime.evaluate('history.back()')` so SPA shadows of
   * `window.history` don't break the buttons. Returns the same value the
   * `ChromeSession` helper returns (boolean for back/forward, void for reload).
   */
  async nav(
    userId: string,
    sessionId: string,
    action: 'back' | 'forward' | 'reload',
  ): Promise<unknown> {
    const s = this.requireOwned(userId, sessionId);
    s.lastHeartbeat = Date.now();
    if (action === 'back') return chromeOf(s).goHistory(-1);
    if (action === 'forward') return chromeOf(s).goHistory(1);
    if (action === 'reload') {
      await chromeOf(s).reload();
      return true;
    }
    throw new Error(`unknown nav action: ${String(action)}`);
  }

  heartbeat(userId: string, sessionId: string): void {
    const s = this.getOwned(userId, sessionId);
    if (!s) return;
    s.lastHeartbeat = Date.now();
    s.panelAttached = true;
  }

  /** Run `fn` after every earlier action on this tab has finished. */
  runExclusive<T>(s: BrowserSession, fn: () => Promise<T>): Promise<T> {
    const run = s.queue.then(fn, fn);
    s.queue = run.catch(() => {});
    return run;
  }

  async dispatchInput(
    userId: string,
    sessionId: string,
    input: WSBrowserSessionInputData,
  ): Promise<void> {
    const s = this.getOwned(userId, sessionId);
    if (!s) {
      log.warn('dispatchInput: no session', { namespace: NS, sessionId, kind: input.kind });
      return;
    }
    s.lastHeartbeat = Date.now();
    const cs = chromeOf(s);
    await this.runExclusive(s, () => PANEL_INPUT[input.kind](cs, input));
  }

  /** Run JS in the page; returns whatever value the expression evaluates to. */
  async execute(userId: string, sessionId: string, expression: string): Promise<unknown> {
    const s = this.requireOwned(userId, sessionId);
    s.lastHeartbeat = Date.now();
    return chromeOf(s).execute(expression);
  }

  async inspectAt(userId: string, sessionId: string, x: number, y: number): Promise<unknown> {
    const span = startSpan('browser_session.inspect', { attributes: { kind: 'point' } });
    try {
      const result = await this.execute(
        userId,
        sessionId,
        `(() => { const el = document.elementFromPoint(${x}, ${y}); return window.__funnyElementInfo ? window.__funnyElementInfo(el) : null; })()`,
      );
      span.end('ok');
      return result;
    } catch (err) {
      span.end('error', errorMessage(err));
      throw err;
    }
  }

  async inspectRect(
    userId: string,
    sessionId: string,
    x: number,
    y: number,
    w: number,
    h: number,
  ): Promise<unknown> {
    const span = startSpan('browser_session.inspect', { attributes: { kind: 'rect' } });
    try {
      // Sample a sparse grid inside the rect (5×5 = 25 points), dedupe by
      // element identity, return up to 10 by area-of-intersection desc.
      const result = await this.execute(
        userId,
        sessionId,
        `
        (() => {
          const X=${x}, Y=${y}, W=${w}, H=${h};
          const found = new Map();
          const stepX = W / 4, stepY = H / 4;
          for (let i = 0; i <= 4; i++) {
            for (let j = 0; j <= 4; j++) {
              const el = document.elementFromPoint(X + i * stepX, Y + j * stepY);
              if (el && !found.has(el)) found.set(el, true);
            }
          }
          const elements = [];
          for (const el of found.keys()) {
            const info = window.__funnyElementInfo(el);
            if (!info) continue;
            const ix = Math.max(0, Math.min(X + W, info.boundingBox.x + info.boundingBox.w) - Math.max(X, info.boundingBox.x));
            const iy = Math.max(0, Math.min(Y + H, info.boundingBox.y + info.boundingBox.h) - Math.max(Y, info.boundingBox.y));
            const inter = ix * iy;
            if (inter <= 0) continue;
            elements.push({ ...info, intersectionArea: inter });
          }
          return elements.sort((a, b) => b.intersectionArea - a.intersectionArea).slice(0, 10);
        })()
        `,
      );
      span.end('ok');
      return result;
    } catch (err) {
      span.end('error', errorMessage(err));
      throw err;
    }
  }

  async screenshot(userId: string, sessionId: string): Promise<string> {
    const s = this.requireOwned(userId, sessionId);
    s.lastHeartbeat = Date.now();
    return chromeOf(s).screenshot();
  }

  /** Resize the page viewport (panel coordinates follow via `browser-session:viewport`). */
  async setViewport(s: BrowserSession, width: number, height: number): Promise<void> {
    await chromeOf(s).setViewport(width, height);
    s.viewport = { width, height };
    this.emit(s, 'browser-session:viewport', { sessionId: s.sessionId, width, height });
  }

  /**
   * Dispatch a request-style WS message and reply with a `browser-session:result`.
   * Centralizes the requestId routing so handlers stay simple.
   */
  async handleRequest(
    userId: string,
    sessionId: string,
    requestId: string,
    fn: () => Promise<unknown>,
  ): Promise<void> {
    let result: WSBrowserSessionResultData;
    try {
      const value = await fn();
      result = { sessionId, requestId, ok: true, value };
    } catch (err) {
      result = { sessionId, requestId, ok: false, error: errorMessage(err) };
    }
    wsBroker.emitToUser(userId, {
      type: 'browser-session:result',
      threadId: '',
      data: result,
    });
  }

  // ── Close ────────────────────────────────────────────────────────────────

  /**
   * Client-initiated close. `detach` keeps thread-bound sessions running;
   * `clear-profile` wipes the user's persistent profile.
   */
  async closeFromClient(userId: string, sessionId: string, reason?: string): Promise<void> {
    if (reason === 'clear-profile') {
      await this.clearProfile(userId);
      return;
    }
    const s = this.getOwned(userId, sessionId);
    if (!s) return;
    if (s.owner === 'thread' && (reason === 'detach' || reason === 'unmount')) {
      s.panelAttached = false;
      log.info('Panel detached from thread session', { namespace: NS, sessionId });
      return;
    }
    await this.close(sessionId, 'user');
  }

  /** Fire-and-forget close: the session is already gone from the map, so a
   *  failure may leave Chrome running — make it visible instead of silent. */
  private closeAndLog(sessionId: string, reason: BrowserSessionClosedReason): void {
    this.close(sessionId, reason).catch((err) => {
      log.warn('Failed to close browser session', {
        namespace: NS,
        sessionId,
        reason,
        error: errorMessage(err),
      });
    });
  }

  async close(sessionId: string, reason: BrowserSessionClosedReason): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    this.sessions.delete(sessionId);

    log.info('Closing browser session', { namespace: NS, sessionId, reason });

    const chromeSession = s.chromeSession;
    s.chromeSession = null;
    await chromeSession?.disconnect().catch(() => {});
    for (const tab of [s.tab, ...s.backgroundTabs]) await s.host.closeTab(tab);

    metric('browser_session.closed', 1, { type: 'sum', attributes: { reason } });
    this.emit(s, 'browser-session:closed', { sessionId, reason });

    this.scheduleHostShutdownIfUnused(s.userId);
    this.stopReaperIfIdle();
  }

  async closeForThread(userId: string, threadId: string): Promise<void> {
    const s = this.findByThread(userId, threadId);
    if (s) await this.close(s.sessionId, 'thread_deleted');
  }

  /** Close every session of the user, stop Chromium and delete the profile. */
  async clearProfile(userId: string): Promise<void> {
    const ids = Array.from(this.sessions.values())
      .filter((s) => s.userId === userId)
      .map((s) => s.sessionId);
    await Promise.all(ids.map((id) => this.close(id, 'user')));
    const entry = this.hosts.get(userId);
    if (entry?.launching) await entry.launching.catch(() => {});
    if (entry?.graceTimer) clearTimeout(entry.graceTimer);
    if (entry?.host) await entry.host.shutdown();
    this.hosts.delete(userId);
    await rm(profileDirFor(userId), { recursive: true, force: true });
    metric('browser_session.profile_cleared', 1, { type: 'sum' });
    log.info('Browser profile cleared', { namespace: NS, userId });
  }

  /** Force-close all sessions and hosts — used on runner shutdown. */
  async closeAll(): Promise<void> {
    const ids = Array.from(this.sessions.keys());
    await Promise.all(ids.map((id) => this.close(id, 'runner_shutdown')));
    const hosts = Array.from(this.hosts.values());
    this.hosts.clear();
    await Promise.all(
      hosts.map(async (entry) => {
        if (entry.graceTimer) clearTimeout(entry.graceTimer);
        await entry.host?.shutdown();
      }),
    );
  }

  /** Remove temp profiles left by the pre-host process-per-session model. */
  async cleanupLegacyTempProfiles(): Promise<void> {
    const root = tmpdir();
    const entries = await readdir(root).catch(() => [] as string[]);
    await Promise.all(
      entries
        .filter((e) => e.startsWith('funny-browser-'))
        .map((e) => rm(join(root, e), { recursive: true, force: true }).catch(() => {})),
    );
  }

  /** Inspection: how many active sessions, who owns them. */
  getStats() {
    return {
      activeSessions: this.sessions.size,
      maxSessions: MAX_SESSIONS,
      sessions: Array.from(this.sessions.values()).map((s) => ({
        sessionId: s.sessionId,
        userId: s.userId,
        threadId: s.threadId,
        owner: s.owner,
        port: s.host.port,
        url: s.url,
        idleMs: Date.now() - s.lastHeartbeat,
      })),
    };
  }
}

export const browserSessionManager = new BrowserSessionManager();

// Old process-per-session temp profiles are never reused — sweep them once.
void browserSessionManager.cleanupLegacyTempProfiles();

shutdownManager.register(
  'browser-sessions',
  () => browserSessionManager.closeAll(),
  ShutdownPhase.SERVICES,
);
