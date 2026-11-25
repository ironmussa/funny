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

import type {
  BrowserSessionClosedReason,
  BrowserSessionAgentAction,
  BrowserSessionPointerKind,
  WSBrowserSessionConsoleData,
  WSBrowserSessionErrorData,
  WSBrowserSessionInputData,
  WSBrowserSessionReadyData,
  WSBrowserSessionResultData,
  WSEvent,
} from '@funny/shared';
import { threadBrowserSessionId, threadIdFromBrowserSessionId } from '@funny/shared';
import type { Page } from 'playwright';

import { log } from '../lib/logger.js';
import { metric, startSpan } from '../lib/telemetry.js';
import {
  profileDirFor,
  type BrowserHost,
  type BrowserProfileKind,
  type BrowserTab,
} from './browser-automation/browser-host.js';
import { applyPageAudio, installPageAudio } from './browser-automation/page-audio.js';
import { BrowserHostPool } from './browser-session/host-pool.js';
import { inspectAtExpression, inspectRectExpression } from './browser-session/inspect-scripts.js';
import { PANEL_INPUT, panelViewportSize } from './browser-session/panel-input.js';
import {
  chromeOf,
  errorMessage,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
  INSPECT_HELPERS,
  MAX_CONSOLE_ERRORS,
  MAX_SESSIONS,
  newSessionRecord,
  NS,
  THREAD_IDLE_TIMEOUT_MS,
  VIEWPORT_HEIGHT,
  VIEWPORT_WIDTH,
  type BrowserController,
  type BrowserSession,
  type OpenSessionOptions,
  type PageValue,
} from './browser-session/session-record.js';
import { shutdownManager, ShutdownPhase } from './shutdown-manager.js';
import { wsBroker } from './ws-broker.js';

export { panelViewportSize } from './browser-session/panel-input.js';
export type { BrowserSession } from './browser-session/session-record.js';

/** The realtime events a browser session sends to its user. */
type BrowserSessionWSEvent = Extract<WSEvent, { type: `browser-session:${string}` }>;

class BrowserSessionManager {
  private sessions = new Map<string, BrowserSession>();
  /** In-flight first opens, keyed by session id — see `open()`. */
  private opening = new Map<string, Promise<BrowserSession | null>>();
  private hosts = new BrowserHostPool({
    onHostExit: (userId, detail) => this.onHostExit(userId, detail),
    pageAudioMuted: (page) => this.pageAudioMuted(page),
    userHasSessions: (userId) =>
      Array.from(this.sessions.values()).some((s) => s.userId === userId),
  });
  private reaperTimer: ReturnType<typeof setInterval> | null = null;

  private emit<T extends BrowserSessionWSEvent['type']>(
    s: { userId: string; threadId: string | null },
    type: T,
    // The session's thread binding is added below.
    data: Omit<Extract<BrowserSessionWSEvent, { type: T }>['data'], 'threadId'>,
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
    // The panel also reads who controls the page and the audio state on attach.
    const ready: Omit<WSBrowserSessionReadyData, 'threadId'> &
      Pick<BrowserSession, 'controller' | 'audioMuted'> = {
      sessionId: s.sessionId,
      url: s.url,
      viewport: s.viewport,
      controller: s.controller,
      audioMuted: s.audioMuted,
    };
    this.emit(s, 'browser-session:ready', ready);
    this.emit(s, 'browser-session:viewport', { sessionId: s.sessionId, ...s.viewport });
    // A re-attaching panel starts from defaults: restate who controls the page
    // and any dialog still waiting for an answer.
    this.emit(s, 'browser-session:controller', {
      sessionId: s.sessionId,
      controller: s.controller,
    });
    if (s.pendingDialog) this.emitDialog(s);
    // The screencast only sends frames on repaint: give a (re)attaching panel
    // the current picture of a static page right away.
    void this.captureFrame(s)
      .then((frame) => {
        if (frame) this.emit(s, 'browser-session:frame', { sessionId: s.sessionId, ...frame });
      })
      .catch(() => {});
  }

  /** The page the session shows changed: keep the panel's URL bar on it. */
  private setUrl(s: BrowserSession, url: string): void {
    if (url === s.url) return;
    s.url = url;
    this.emit(s, 'browser-session:navigated', { sessionId: s.sessionId, url });
  }

  private emitDialog(s: BrowserSession): void {
    const pending = s.pendingDialog;
    this.emit(s, 'browser-session:dialog', {
      sessionId: s.sessionId,
      dialog: pending
        ? { type: pending.type, message: pending.message, defaultValue: pending.defaultValue }
        : null,
    });
  }

  /** A JPEG of the current viewport, shaped like a screencast frame. */
  async captureFrame(s: BrowserSession): Promise<{ data: string; timestamp: number } | null> {
    if (!s.chromeSession || s.pendingDialog) return null;
    const data = await s.chromeSession.screenshot('jpeg', 60);
    return { data, timestamp: Date.now() / 1000 };
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

  private onHostExit(userId: string, detail: string): void {
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

    const existing = this.sessions.get(sessionId);
    if (existing) return this.reuseSession(existing, userId, url, opts.origin);

    // Serialise concurrent first opens for the same session id. Opening a tab
    // awaits Chromium, so without this two opens that both miss the map above
    // each open a tab and the second `sessions.set` orphans the first tab
    // (leaked, never closed). A concurrent open awaits the in-flight one and
    // then reuses its session (navigate + (re)attach), as a late open would.
    const inFlight = this.opening.get(sessionId);
    if (inFlight) {
      const created = await inFlight;
      if (created) return this.reuseSession(created, userId, url, opts.origin);
      // The in-flight open produced no session (e.g. a panel attach of a
      // missing id): fall through and try to create one ourselves.
    }

    const creating = this.createSession(userId, sessionId, url, opts);
    this.opening.set(sessionId, creating);
    try {
      return await creating;
    } finally {
      if (this.opening.get(sessionId) === creating) this.opening.delete(sessionId);
    }
  }

  /** Create, register and start a brand-new session. Guarded by `opening`. */
  private async createSession(
    userId: string,
    sessionId: string,
    url: string,
    opts: OpenSessionOptions,
  ): Promise<BrowserSession | null> {
    const threadId = opts.threadId ?? threadIdFromBrowserSessionId(sessionId);

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
      const host = await this.hosts.hostFor(userId);
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
      this.hosts.scheduleShutdownIfUnused(userId);
      throw err;
    }
  }

  /** Attach the panel client, watch the page and load the first URL; closes on failure. */
  private async startSession(session: BrowserSession, url: string): Promise<void> {
    try {
      await this.attachChromeSession(session, session.tab.targetId);
      await this.hookPage(session, session.tab.page);
      if (url) await chromeOf(session).navigate(url);
      await chromeOf(session)
        .execute(INSPECT_HELPERS)
        .catch((cause: unknown) => {
          log.warn('Failed to install inspect helpers', {
            namespace: NS,
            sessionId: session.sessionId,
            error: String(cause),
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
      s.recorder?.addFrame(frame.data, frame.timestamp);
      this.emit(s, 'browser-session:frame', {
        sessionId: s.sessionId,
        data: frame.data,
        timestamp: frame.timestamp,
      });
    });
    chromeSession.on('console', (entry: Omit<WSBrowserSessionConsoleData, 'sessionId'>) => {
      if (s.chromeSession !== chromeSession) return;
      this.emit(s, 'browser-session:console', { sessionId: s.sessionId, ...entry });
    });
    chromeSession.on('error', (err: Omit<WSBrowserSessionErrorData, 'sessionId'>) => {
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
    try {
      await chromeSession.connect();
      // Lock the page viewport so the screencast frame size matches the
      // coordinate space the client uses to translate clicks.
      await chromeSession
        .setViewport(s.viewport.width, s.viewport.height)
        .catch((cause: unknown) => {
          log.warn('Failed to set viewport', {
            namespace: NS,
            sessionId: s.sessionId,
            error: String(cause),
          });
        });
    } finally {
      // Always release the client we replaced, even when the new connect
      // throws — otherwise a failed re-attach (popup switch / tab restore)
      // leaks the previous CDP WebSocket to Chromium.
      if (previous) await previous.disconnect().catch(() => {});
    }
  }

  /** Watch a tab's page and hold its audio at the session's setting. */
  private async hookPage(s: BrowserSession, page: Page): Promise<void> {
    this.watchPage(s, page);
    await installPageAudio(page, () => this.pageAudioMuted(page)).catch((cause: unknown) => {
      log.warn('Could not hook page audio', {
        namespace: NS,
        sessionId: s.sessionId,
        error: errorMessage(cause),
      });
    });
  }

  /** Turn the session's page audio on or off (it starts muted). */
  async setAudioMuted(s: BrowserSession, muted: boolean): Promise<void> {
    if (s.audioMuted === muted) return;
    s.audioMuted = muted;
    await Promise.all([s.tab, ...s.backgroundTabs].map((tab) => applyPageAudio(tab.page, muted)));
    metric('browser_session.audio_changed', 1, {
      type: 'sum',
      attributes: { muted: String(muted) },
    });
    this.emit(s, 'browser-session:audio', { sessionId: s.sessionId, muted });
  }

  /** Playwright-side listeners: navigation invalidates refs, dialogs, popups, errors. */
  private watchPage(s: BrowserSession, page: Page): void {
    page.on('framenavigated', (frame) => {
      if (s.tab.page !== page || frame !== page.mainFrame()) return;
      this.setUrl(s, frame.url());
      s.refs.invalidate('navigation');
    });
    page.on('dialog', (dialog) => {
      if (s.tab.page !== page) return;
      // Hold the dialog until the agent (browser_dialog) or the user (panel)
      // answers it; the page is frozen meanwhile.
      s.pendingDialog = {
        type: dialog.type(),
        message: dialog.message(),
        defaultValue: dialog.defaultValue(),
        dialog,
      };
      this.emitDialog(s);
      s.signals.emit('dialog');
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
      // A background tab's popup stays in the background, but belongs to the
      // session: it is muted with it and closed by Stop.
      if (s.tab.page !== page) {
        void this.adoptBackgroundPopup(s, popup);
        return;
      }
      void this.followPopup(s, popup).catch((err) => {
        log.warn('Could not follow popup', {
          namespace: NS,
          sessionId: s.sessionId,
          error: String(err),
        });
      });
    });
  }

  /** Track a popup opened by a background tab, so it is closed with the session. */
  private async adoptBackgroundPopup(s: BrowserSession, popup: Page): Promise<void> {
    s.backgroundTabs.push({ page: popup, targetId: '', ephemeralContext: null });
    log.info('Session adopted a background popup', { namespace: NS, sessionId: s.sessionId });
    await this.hookPage(s, popup);
  }

  /** The audio setting of the session that owns a page; pages of no session stay muted. */
  private pageAudioMuted(page: Page): boolean {
    for (const s of this.sessions.values()) {
      if (s.tab.page === page || s.backgroundTabs.some((tab) => tab.page === page)) {
        return s.audioMuted;
      }
    }
    return true;
  }

  /** Keep one active tab per session: switch the session (and panel) to a popup. */
  private async followPopup(s: BrowserSession, popup: Page): Promise<void> {
    const cdp = await popup.context().newCDPSession(popup);
    const info = (await cdp.send('Target.getTargetInfo')) as { targetInfo: { targetId: string } };
    await cdp.detach().catch(() => {});
    s.backgroundTabs.push(s.tab);
    s.tab = { page: popup, targetId: info.targetInfo.targetId, ephemeralContext: null };
    s.refs.invalidate('navigation');
    this.setUrl(s, popup.url());
    await this.hookPage(s, popup);
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
    this.setUrl(s, previous.page.url());
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
    // The page's own URL, after redirects (the navigation already reported it).
    this.setUrl(s, s.tab.page.url() || url);
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
  ): Promise<boolean> {
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
    // Control and dialog answers bypass the queue: an action blocked behind a
    // dialog would otherwise wait for its own answer.
    if (input.kind === 'takeControl' || input.kind === 'releaseControl') {
      this.setController(s, input.kind === 'takeControl' ? 'user' : 'agent');
      return;
    }
    if (input.kind === 'dialog') {
      await this.answerDialog(s, input.accept === true, input.promptText);
      return;
    }
    if (input.kind === 'audio') {
      await this.setAudioMuted(s, input.muted !== false);
      return;
    }
    if (input.kind === 'viewport') {
      const size = panelViewportSize(input);
      if (!size) {
        log.warn('dispatchInput: invalid viewport size', { namespace: NS, sessionId });
        return;
      }
      await this.runExclusive(s, () => this.setViewport(s, size.width, size.height));
      return;
    }
    const cs = chromeOf(s);
    const handler = PANEL_INPUT[input.kind];
    await this.runExclusive(s, () => handler(cs, input));
  }

  /** Hand the session to the user or back to the agent; agent refs expire. */
  setController(s: BrowserSession, controller: BrowserController): void {
    if (s.controller === controller) return;
    s.controller = controller;
    s.refs.invalidate('control');
    log.info('Browser session controller changed', {
      namespace: NS,
      sessionId: s.sessionId,
      controller,
    });
    metric('browser_session.controller_changed', 1, {
      type: 'sum',
      attributes: { controller },
    });
    this.emit(s, 'browser-session:controller', { sessionId: s.sessionId, controller });
  }

  /** Tell the panel where the agent's mouse goes (it draws the cursor). */
  emitPointer(
    s: BrowserSession,
    point: { x: number; y: number },
    kind: BrowserSessionPointerKind,
  ): void {
    this.emit(s, 'browser-session:pointer', {
      sessionId: s.sessionId,
      x: Math.round(point.x),
      y: Math.round(point.y),
      kind,
    });
  }

  /** Tell the panel what the agent does, so it can show it over the page. */
  emitAgentAction(s: BrowserSession, action: BrowserSessionAgentAction): void {
    this.emit(s, 'browser-session:agent-action', { sessionId: s.sessionId, ...action });
  }

  /** Accept or dismiss the pending dialog. Returns false when none is open. */
  async answerDialog(s: BrowserSession, accept: boolean, promptText?: string): Promise<boolean> {
    const pending = s.pendingDialog;
    if (!pending) return false;
    s.pendingDialog = null;
    if (accept) await pending.dialog.accept(promptText).catch(() => {});
    else await pending.dialog.dismiss().catch(() => {});
    this.emitDialog(s);
    return true;
  }

  /** Run JS in the page; returns whatever value the expression evaluates to. */
  async execute(userId: string, sessionId: string, expression: string): Promise<PageValue> {
    const s = this.requireOwned(userId, sessionId);
    s.lastHeartbeat = Date.now();
    return chromeOf(s).execute(expression);
  }

  async inspectAt(userId: string, sessionId: string, x: number, y: number): Promise<PageValue> {
    const span = startSpan('browser_session.inspect', { attributes: { kind: 'point' } });
    try {
      const result = await this.execute(userId, sessionId, inspectAtExpression(x, y));
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
  ): Promise<PageValue> {
    const span = startSpan('browser_session.inspect', { attributes: { kind: 'rect' } });
    try {
      const result = await this.execute(userId, sessionId, inspectRectExpression(x, y, w, h));
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
    fn: () => Promise<PageValue>,
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
  async closeFromClient(
    userId: string,
    sessionId: string,
    reason?: string,
    /** Echoed in the `closed` event, so the client can match its own close. */
    closeId?: string,
  ): Promise<void> {
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
    await this.close(sessionId, 'user', closeId);
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

  async close(
    sessionId: string,
    reason: BrowserSessionClosedReason,
    closeId?: string,
  ): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    this.sessions.delete(sessionId);

    log.info('Closing browser session', { namespace: NS, sessionId, reason });

    const chromeSession = s.chromeSession;
    s.chromeSession = null;
    await s.recorder?.discard();
    s.recorder = null;
    await s.pendingDialog?.dialog.dismiss().catch(() => {});
    s.pendingDialog = null;
    await chromeSession?.disconnect().catch(() => {});
    for (const tab of [s.tab, ...s.backgroundTabs]) await s.host.closeTab(tab);

    metric('browser_session.closed', 1, { type: 'sum', attributes: { reason } });
    this.emit(s, 'browser-session:closed', {
      sessionId,
      reason,
      closeId: closeId || undefined,
    });

    this.hosts.scheduleShutdownIfUnused(s.userId);
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
    await this.hosts.shutdownFor(userId);
    await rm(profileDirFor(userId), { recursive: true, force: true });
    metric('browser_session.profile_cleared', 1, { type: 'sum' });
    log.info('Browser profile cleared', { namespace: NS, userId });
  }

  /** Force-close all sessions and hosts — used on runner shutdown. */
  async closeAll(): Promise<void> {
    const ids = Array.from(this.sessions.keys());
    await Promise.all(ids.map((id) => this.close(id, 'runner_shutdown')));
    await this.hosts.shutdownAll();
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
