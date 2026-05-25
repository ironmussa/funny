/**
 * Browser annotator panel — runner-side session manager.
 *
 * Each panel session owns one Chromium subprocess (spawned via Playwright's
 * bundled binary) + one `ChromeSession` from `@funny/core/chrome`. We do not
 * use the Playwright test runner here — we want a long-running browser, not
 * test execution. `ChromeSession` already handles CDP screencast / input /
 * console / network / error capture, so this manager is mostly lifecycle.
 *
 * Runtime log level override:
 *   __funnyLog.setNamespaceLevel('browser-session', 'debug')
 */

import { spawn, type ChildProcess } from 'child_process';
import { randomBytes } from 'crypto';
import { existsSync } from 'fs';
import { mkdtemp, readdir, rm } from 'fs/promises';
import { homedir, tmpdir } from 'os';
import { join } from 'path';

import type {
  BrowserSessionClosedReason,
  WSBrowserSessionInputData,
  WSBrowserSessionResultData,
} from '@funny/shared';
import {
  cssSelector,
  detectFrameworkComponent,
  extractElementInfo,
  pickStyles,
} from '@funny/shared/dom/extract';

import { log } from '../lib/logger.js';
import { metric, startSpan } from '../lib/telemetry.js';
import { wsBroker } from './ws-broker.js';

const NS = 'browser-session';
const BASE_PORT = 9300; // test-runner uses 9223; keep us out of that range
const MAX_SESSIONS = 4; // per runner
const HEARTBEAT_INTERVAL_MS = 30_000;
const HEARTBEAT_TIMEOUT_MS = 90_000;
const SPAWN_TIMEOUT_MS = 30_000;
// Keep in sync with packages/client/src/lib/browser-session-viewport.ts
const VIEWPORT_WIDTH = 1920;
const VIEWPORT_HEIGHT = 1080;

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

interface BrowserSession {
  sessionId: string;
  userId: string;
  port: number;
  url: string;
  chromeProcess: ChildProcess;
  userDataDir: string;
  /** Lazy-loaded via dynamic import to avoid top-level dep on core. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  chromeSession: any;
  lastHeartbeat: number;
}

class BrowserSessionManager {
  private sessions = new Map<string, BrowserSession>();
  private reaperTimer: ReturnType<typeof setInterval> | null = null;

  private startReaper() {
    if (this.reaperTimer) return;
    this.reaperTimer = setInterval(() => {
      const now = Date.now();
      for (const s of this.sessions.values()) {
        if (now - s.lastHeartbeat > HEARTBEAT_TIMEOUT_MS) {
          log.warn('Reaping idle browser session', {
            namespace: NS,
            sessionId: s.sessionId,
            idleMs: now - s.lastHeartbeat,
          });
          this.close(s.sessionId, 'heartbeat').catch(() => {});
        }
      }
    }, HEARTBEAT_INTERVAL_MS);
    this.reaperTimer.unref?.();
  }

  private stopReaperIfIdle() {
    if (this.sessions.size === 0 && this.reaperTimer) {
      clearInterval(this.reaperTimer);
      this.reaperTimer = null;
    }
  }

  /** Find an available port starting from BASE_PORT and avoiding currently-used ones. */
  private async allocatePort(): Promise<number> {
    const { findAvailablePort } = await import('@funny/core/ports');
    const used = new Set(Array.from(this.sessions.values()).map((s) => s.port));
    return findAvailablePort(BASE_PORT, used);
  }

  /**
   * Resolve the Chromium binary path with a fallback when Playwright's reported
   * path doesn't exist on disk. Common case: `chromium.executablePath()` returns
   * a path inside VSCode's flatpak cache when funny is launched from VSCode's
   * integrated terminal — that path is invisible to the runner outside the
   * sandbox.
   *
   * Fallback strategy: scan `$PLAYWRIGHT_BROWSERS_PATH || ~/.cache/ms-playwright/`
   * for `chromium-N` subdirs (then a `chrome-linux64/chrome` inside) and return
   * the newest one that actually exists.
   */
  private async resolveChromiumBinary(): Promise<string> {
    const { chromium } = await import('playwright');
    const reported = chromium.executablePath();
    if (reported && existsSync(reported)) return reported;

    log.warn('Playwright executablePath does not exist on disk, falling back', {
      namespace: NS,
      reported,
    });

    const root = process.env.PLAYWRIGHT_BROWSERS_PATH || join(homedir(), '.cache', 'ms-playwright');
    try {
      const entries = await readdir(root);
      const chromiumDirs = entries
        .filter((e) => e.startsWith('chromium-'))
        .map((e) => ({
          dir: e,
          version: Number.parseInt(e.replace('chromium-', ''), 10) || 0,
        }))
        .sort((a, b) => b.version - a.version);

      for (const { dir } of chromiumDirs) {
        for (const subpath of [
          'chrome-linux64/chrome',
          'chrome-linux/chrome',
          'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
        ]) {
          const candidate = join(root, dir, subpath);
          if (existsSync(candidate)) return candidate;
        }
      }
    } catch (err) {
      log.error('Could not scan for Chromium binaries', {
        namespace: NS,
        root,
        error: String(err),
      });
    }

    throw new Error(
      `No Chromium binary found. Run \`bunx playwright install chromium\` or set PLAYWRIGHT_BROWSERS_PATH to a directory containing chromium-N/chrome-linux64/chrome. Searched: ${root}`,
    );
  }

  async open(userId: string, sessionId: string, url: string): Promise<void> {
    log.info('open() called', {
      namespace: NS,
      sessionId,
      userId,
      url,
      env: {
        PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH || '(unset)',
        HOME: process.env.HOME || '(unset)',
      },
    });

    if (this.sessions.has(sessionId)) {
      log.warn('Reusing session via navigate', { namespace: NS, sessionId });
      return this.navigate(sessionId, url);
    }
    if (this.sessions.size >= MAX_SESSIONS) {
      log.warn('Too many sessions, refusing open', {
        namespace: NS,
        sessionId,
        active: this.sessions.size,
      });
      wsBroker.emitToUser(userId, {
        type: 'browser-session:closed',
        threadId: '',
        data: { sessionId, reason: 'too_many_sessions' },
      });
      throw new Error('too-many-sessions');
    }

    const port = await this.allocatePort();
    const userDataDir = await mkdtemp(
      join(tmpdir(), `funny-browser-${randomBytes(4).toString('hex')}-`),
    );

    log.info('Spawning Chromium', { namespace: NS, sessionId, port, url });

    const { ChromeSession, waitForChrome } = await import('@funny/core/chrome');

    let binary: string;
    try {
      binary = await this.resolveChromiumBinary();
      log.info('Chromium binary resolved', { namespace: NS, sessionId, binary });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
      log.error('Cannot find Chromium binary', { namespace: NS, sessionId, error: msg });
      wsBroker.emitToUser(userId, {
        type: 'browser-session:closed',
        threadId: '',
        data: { sessionId, reason: 'error', message: msg },
      });
      throw err;
    }
    const chromeArgs = [
      `--remote-debugging-port=${port}`,
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--hide-scrollbars',
      `--window-size=${VIEWPORT_WIDTH},${VIEWPORT_HEIGHT}`,
      `--user-data-dir=${userDataDir}`,
      'about:blank',
    ];

    log.info('Spawning Chromium', { namespace: NS, sessionId, binary, args: chromeArgs });

    const proc = spawn(binary, chromeArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    });

    // Buffer recent stderr so we can include it in the error payload if the
    // process dies during boot. Chromium dumps useful info there (missing
    // .so libs, sandbox failures, etc.).
    const stderrTail: string[] = [];
    proc.stderr?.on('data', (chunk) => {
      const text = chunk.toString();
      stderrTail.push(text);
      if (stderrTail.length > 20) stderrTail.shift();
      // Surface lines that look like real errors at warn level.
      if (
        text.includes('ERROR') ||
        text.includes('FATAL') ||
        text.includes('error while loading shared libraries')
      ) {
        log.warn('Chromium stderr', { namespace: NS, sessionId, text: text.slice(0, 400) });
      }
    });

    // `error` event fires when the binary itself can't be invoked (ENOENT,
    // EACCES). `exit` fires when it ran but died. Both are fatal during boot.
    let bootFailed = false;
    let bootFailureMessage = '';
    proc.on('error', (err) => {
      bootFailed = true;
      bootFailureMessage = `spawn failed: ${err.message}`;
      log.error('Chromium spawn error', { namespace: NS, sessionId, binary, error: err.message });
    });
    proc.on('exit', (code, signal) => {
      log.info('Chromium exited', { namespace: NS, sessionId, code, signal });
      if (this.sessions.has(sessionId)) {
        this.close(sessionId, 'error').catch(() => {});
      } else if (code !== 0 && code !== null) {
        // Died during boot.
        bootFailed = true;
        bootFailureMessage = `Chromium exited with code ${code}${signal ? ` (${signal})` : ''}: ${stderrTail.join('').slice(-400)}`;
      }
    });

    // Wait for CDP to be ready
    try {
      await waitForChrome('localhost', port, SPAWN_TIMEOUT_MS);
    } catch (err) {
      proc.kill('SIGKILL');
      await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
      const detail = bootFailed
        ? bootFailureMessage
        : `Chromium did not expose CDP on port ${port} within ${SPAWN_TIMEOUT_MS}ms. stderr tail: ${stderrTail.join('').slice(-400)}`;
      log.error('Chromium did not expose CDP in time', {
        namespace: NS,
        sessionId,
        port,
        error: String(err),
        detail,
      });
      wsBroker.emitToUser(userId, {
        type: 'browser-session:closed',
        threadId: '',
        data: { sessionId, reason: 'error', message: detail },
      });
      throw err;
    }

    const chromeSession = new ChromeSession({
      host: 'localhost',
      port,
      format: 'jpeg',
      quality: 60,
      maxWidth: VIEWPORT_WIDTH,
      maxHeight: VIEWPORT_HEIGHT,
      everyNthFrame: 1,
    });

    // Wire events BEFORE connect so we don't miss the early frames.
    chromeSession.on('frame', (frame: { data: string; timestamp: number }) => {
      wsBroker.emitToUser(userId, {
        type: 'browser-session:frame',
        threadId: '',
        data: { sessionId, data: frame.data, timestamp: frame.timestamp },
      });
    });

    chromeSession.on(
      'console',
      (entry: {
        level: string;
        text: string;
        url?: string;
        line?: number;
        column?: number;
        timestamp: number;
      }) => {
        wsBroker.emitToUser(userId, {
          type: 'browser-session:console',
          threadId: '',
          data: { sessionId, ...entry },
        });
      },
    );

    chromeSession.on(
      'error',
      (err: {
        message: string;
        source?: string;
        line?: number;
        column?: number;
        stack?: string;
        timestamp: number;
      }) => {
        wsBroker.emitToUser(userId, {
          type: 'browser-session:error',
          threadId: '',
          data: { sessionId, ...err },
        });
      },
    );

    chromeSession.on('disconnect', () => {
      log.warn('Chrome disconnected', { namespace: NS, sessionId });
      if (this.sessions.has(sessionId)) {
        this.close(sessionId, 'error').catch(() => {});
      }
    });

    await chromeSession.connect();
    // Lock the page viewport to exactly VIEWPORT_WIDTH×VIEWPORT_HEIGHT so the
    // screencast frame size matches the canvas/overlay coordinate space the
    // client uses to translate clicks. Without this, Chromium derives the
    // viewport from the OS window and frames can come back slightly smaller,
    // making clicks drift toward the corner the further from origin they are.
    await chromeSession.setViewport(VIEWPORT_WIDTH, VIEWPORT_HEIGHT).catch((err: unknown) => {
      log.warn('Failed to set viewport', {
        namespace: NS,
        sessionId,
        error: String(err),
      });
    });
    await chromeSession.navigate(url);

    // Install inspect helpers (idempotent — checks __funnyInspectInstalled).
    await chromeSession.execute(INSPECT_HELPERS).catch((err: unknown) => {
      log.warn('Failed to install inspect helpers', {
        namespace: NS,
        sessionId,
        error: String(err),
      });
    });

    const session: BrowserSession = {
      sessionId,
      userId,
      port,
      url,
      chromeProcess: proc,
      userDataDir,
      chromeSession,
      lastHeartbeat: Date.now(),
    };
    this.sessions.set(sessionId, session);
    this.startReaper();

    metric('browser_session.opened', 1, { type: 'sum' });
    log.info('Browser session ready', { namespace: NS, sessionId, port });

    wsBroker.emitToUser(userId, {
      type: 'browser-session:ready',
      threadId: '',
      data: { sessionId, url },
    });
  }

  async navigate(sessionId: string, url: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error('no-session');
    await s.chromeSession.navigate(url);
    // Re-install helpers in case of full reload.
    await s.chromeSession.execute(INSPECT_HELPERS).catch(() => {});
    s.url = url;
    s.lastHeartbeat = Date.now();
  }

  /**
   * Page-level back / forward / reload via CDP `Page` domain. Used by the URL
   * bar instead of `Runtime.evaluate('history.back()')` so SPA shadows of
   * `window.history` don't break the buttons. Returns the same value the
   * `ChromeSession` helper returns (boolean for back/forward, void for reload).
   */
  async nav(sessionId: string, action: 'back' | 'forward' | 'reload'): Promise<unknown> {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error('no-session');
    s.lastHeartbeat = Date.now();
    if (action === 'back') return s.chromeSession.goHistory(-1);
    if (action === 'forward') return s.chromeSession.goHistory(1);
    if (action === 'reload') {
      await s.chromeSession.reload();
      return true;
    }
    throw new Error(`unknown nav action: ${String(action)}`);
  }

  heartbeat(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (s) s.lastHeartbeat = Date.now();
  }

  async dispatchInput(sessionId: string, input: WSBrowserSessionInputData): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) {
      log.warn('dispatchInput: no session', { namespace: NS, sessionId, kind: input.kind });
      return;
    }
    s.lastHeartbeat = Date.now();
    const cs = s.chromeSession;

    switch (input.kind) {
      case 'mouseMove':
        await cs.dispatchMouseEvent({ type: 'mouseMoved', x: input.x ?? 0, y: input.y ?? 0 });
        return;
      case 'mouseDown':
        log.info('dispatching mouseDown', {
          namespace: NS,
          sessionId,
          x: input.x,
          y: input.y,
          button: input.button,
        });
        await cs.dispatchMouseEvent({
          type: 'mousePressed',
          x: input.x ?? 0,
          y: input.y ?? 0,
          button: input.button ?? 'left',
          clickCount: input.clickCount ?? 1,
        });
        return;
      case 'mouseUp':
        log.info('dispatching mouseUp', {
          namespace: NS,
          sessionId,
          x: input.x,
          y: input.y,
          button: input.button,
        });
        await cs.dispatchMouseEvent({
          type: 'mouseReleased',
          x: input.x ?? 0,
          y: input.y ?? 0,
          button: input.button ?? 'left',
          clickCount: input.clickCount ?? 1,
        });
        return;
      case 'wheel':
        await cs.dispatchScroll(input.x ?? 0, input.y ?? 0, input.deltaX ?? 0, input.deltaY ?? 0);
        return;
      case 'keyDown':
        log.info('dispatching keyDown', {
          namespace: NS,
          sessionId,
          key: input.key,
          hasText: !!input.text,
          modifiers: input.modifiers,
        });
        await cs.dispatchKeyEvent({
          type: 'keyDown',
          key: input.key ?? '',
          code: input.code ?? '',
          text: input.text,
          modifiers: input.modifiers ?? 0,
        });
        return;
      case 'keyUp':
        log.info('dispatching keyUp', {
          namespace: NS,
          sessionId,
          key: input.key,
          modifiers: input.modifiers,
        });
        await cs.dispatchKeyEvent({
          type: 'keyUp',
          key: input.key ?? '',
          code: input.code ?? '',
          modifiers: input.modifiers ?? 0,
        });
        return;
    }
  }

  /** Run JS in the page; returns whatever value the expression evaluates to. */
  async execute(sessionId: string, expression: string): Promise<unknown> {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error('no-session');
    s.lastHeartbeat = Date.now();
    return s.chromeSession.execute(expression);
  }

  async inspectAt(sessionId: string, x: number, y: number): Promise<unknown> {
    const span = startSpan('browser_session.inspect', { attributes: { kind: 'point' } });
    try {
      const result = await this.execute(
        sessionId,
        `(() => { const el = document.elementFromPoint(${x}, ${y}); return window.__funnyElementInfo ? window.__funnyElementInfo(el) : null; })()`,
      );
      span.end('ok');
      return result;
    } catch (err) {
      span.end('error', err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  async inspectRect(
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
      span.end('error', err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  async screenshot(sessionId: string): Promise<string> {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error('no-session');
    s.lastHeartbeat = Date.now();
    return s.chromeSession.screenshot();
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
      result = {
        sessionId,
        requestId,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    wsBroker.emitToUser(userId, {
      type: 'browser-session:result',
      threadId: '',
      data: result,
    });
  }

  async close(sessionId: string, reason: BrowserSessionClosedReason): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    this.sessions.delete(sessionId);

    log.info('Closing browser session', { namespace: NS, sessionId, reason });

    try {
      await s.chromeSession.disconnect();
    } catch {
      // ignore
    }

    if (!s.chromeProcess.killed) {
      s.chromeProcess.kill('SIGTERM');
      // Force-kill after 2s if SIGTERM didn't take.
      setTimeout(() => {
        if (!s.chromeProcess.killed) s.chromeProcess.kill('SIGKILL');
      }, 2000).unref?.();
    }

    await rm(s.userDataDir, { recursive: true, force: true }).catch(() => {});

    metric('browser_session.closed', 1, { type: 'sum', attributes: { reason } });

    wsBroker.emitToUser(s.userId, {
      type: 'browser-session:closed',
      threadId: '',
      data: { sessionId, reason },
    });

    this.stopReaperIfIdle();
  }

  /** Force-close all sessions — used on runner shutdown. */
  async closeAll(): Promise<void> {
    const ids = Array.from(this.sessions.keys());
    await Promise.all(ids.map((id) => this.close(id, 'runner_shutdown')));
  }

  /** Inspection: how many active sessions, who owns them. */
  getStats() {
    return {
      activeSessions: this.sessions.size,
      maxSessions: MAX_SESSIONS,
      sessions: Array.from(this.sessions.values()).map((s) => ({
        sessionId: s.sessionId,
        userId: s.userId,
        port: s.port,
        url: s.url,
        idleMs: Date.now() - s.lastHeartbeat,
      })),
    };
  }
}

export const browserSessionManager = new BrowserSessionManager();
