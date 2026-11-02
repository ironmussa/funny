/**
 * One headless Chromium per user profile, one tab per browser session.
 *
 * Chromium locks a `--user-data-dir` to a single process, so a persistent
 * profile (logins that survive across sessions) can only be shared by tabs of
 * the same process. The host owns that process and a Playwright connection to
 * it (`connectOverCDP`). Tabs are created through Playwright — the default
 * context for persistent sessions, a fresh `newContext()` for ephemeral ones —
 * and each tab's CDP target id lets the panel's `ChromeSession` attach to the
 * same page for screencast and input.
 */

import { execFile, spawn, type ChildProcess } from 'child_process';
import { existsSync } from 'fs';
import { chmod, mkdir, readdir } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import { promisify } from 'util';

import { buildChildEnv } from '@funny/shared/lib/child-env';
import { ResultAsync } from 'neverthrow';
import type { Browser, BrowserContext, Page } from 'playwright';

import { DATA_DIR } from '../../lib/data-dir.js';
import { log } from '../../lib/logger.js';
import { parseChromeMajor, regularChromeUserAgent } from './user-agent.js';

const NS = 'browser-host';
const SPAWN_TIMEOUT_MS = 30_000;
const execFileAsync = promisify(execFile);

export type BrowserProfileKind = 'persistent' | 'ephemeral';

export interface BrowserTab {
  page: Page;
  /** CDP target id — what `ChromeSession({ targetId })` attaches to. */
  targetId: string;
  /** Ephemeral tabs own their context and dispose it on close. */
  ephemeralContext: BrowserContext | null;
}

export interface BrowserHostOptions {
  binary: string;
  profileDir: string;
  port: number;
  windowWidth: number;
  windowHeight: number;
  /** Called once when the Chromium process exits for any reason. */
  onExit: (detail: string) => void;
}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

/** Directory of a user's persistent browser profile on this runner. */
export function profileDirFor(userId: string): string {
  const safe = userId.replace(/[^A-Za-z0-9_-]/g, '_') || 'anonymous';
  return join(DATA_DIR, 'browser-profiles', safe, 'default');
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
export async function resolveChromiumBinary(): Promise<string> {
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
    `browser-unavailable: No Chromium binary found. Run \`bunx playwright install chromium\` or set PLAYWRIGHT_BROWSERS_PATH to a directory containing chromium-N/chrome-linux64/chrome. Searched: ${root}`,
  );
}

const userAgentCache = new Map<string, string | null>();

/** Regular-Chrome UA for a binary, computed once from `--version`. */
async function userAgentFor(binary: string): Promise<string | null> {
  if (userAgentCache.has(binary)) return userAgentCache.get(binary) ?? null;
  let ua: string | null = null;
  try {
    const { stdout } = await execFileAsync(binary, ['--version'], { timeout: 10_000 });
    const major = parseChromeMajor(stdout);
    ua = major ? regularChromeUserAgent(major) : null;
  } catch (err) {
    log.warn('Could not read Chromium version; keeping default user agent', {
      namespace: NS,
      binary,
      error: String(err),
    });
  }
  userAgentCache.set(binary, ua);
  return ua;
}

export class BrowserHost {
  private constructor(
    private readonly proc: ChildProcess,
    private readonly exited: Promise<void>,
    readonly browser: Browser,
    readonly port: number,
    readonly userAgent: string | null,
  ) {}

  /** Spawn Chromium on the profile and connect Playwright to it. */
  static launch(opts: BrowserHostOptions): ResultAsync<BrowserHost, Error> {
    return ResultAsync.fromPromise(BrowserHost.launchInner(opts), toError);
  }

  private static async launchInner(opts: BrowserHostOptions): Promise<BrowserHost> {
    await mkdir(opts.profileDir, { recursive: true, mode: 0o700 });
    await chmod(opts.profileDir, 0o700).catch(() => {});
    const userAgent = await userAgentFor(opts.binary);

    const args = [
      `--remote-debugging-port=${opts.port}`,
      '--remote-debugging-address=127.0.0.1',
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      `--window-size=${opts.windowWidth},${opts.windowHeight}`,
      `--user-data-dir=${opts.profileDir}`,
      ...(userAgent ? [`--user-agent=${userAgent}`] : []),
      'about:blank',
    ];
    log.info('Launching Chromium host', { namespace: NS, binary: opts.binary, port: opts.port });

    const proc = spawn(opts.binary, args, {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: buildChildEnv(),
      detached: false,
    });

    // Chromium dumps useful boot failures on stderr (missing .so libs, a
    // profile locked by another process, sandbox errors).
    const stderrTail: string[] = [];
    proc.stderr?.on('data', (chunk) => {
      const text = chunk.toString();
      stderrTail.push(text);
      if (stderrTail.length > 20) stderrTail.shift();
      if (text.includes('FATAL') || text.includes('error while loading shared libraries')) {
        log.warn('Chromium stderr', { namespace: NS, text: text.slice(0, 400) });
      }
    });

    let exited = false;
    let exitDetail = '';
    const exitedPromise = new Promise<void>((resolve) => {
      proc.on('error', (e) => {
        exited = true;
        exitDetail = `spawn failed: ${e.message}`;
        resolve();
      });
      proc.on('exit', (code, signal) => {
        exited = true;
        exitDetail = `Chromium exited with code ${code}${signal ? ` (${signal})` : ''}: ${stderrTail.join('').slice(-400)}`;
        resolve();
      });
    });
    void exitedPromise.then(() => {
      log.info('Chromium host exited', { namespace: NS, port: opts.port, detail: exitDetail });
      opts.onExit(exitDetail);
    });

    const { waitForChrome } = await import('@funny/core/chrome');
    try {
      await Promise.race([
        waitForChrome('127.0.0.1', opts.port, SPAWN_TIMEOUT_MS),
        exitedPromise.then(() => {
          throw new Error(exitDetail);
        }),
      ]);
    } catch (e) {
      if (!exited) proc.kill('SIGKILL');
      throw new Error(
        exited
          ? exitDetail
          : `Chromium did not expose CDP on port ${opts.port} within ${SPAWN_TIMEOUT_MS}ms (${toError(e).message}). stderr tail: ${stderrTail.join('').slice(-400)}`,
        { cause: e },
      );
    }

    const { chromium } = await import('playwright');
    try {
      const browser = await chromium.connectOverCDP(`http://127.0.0.1:${opts.port}`);
      return new BrowserHost(proc, exitedPromise, browser, opts.port, userAgent);
    } catch (e) {
      proc.kill('SIGKILL');
      throw toError(e);
    }
  }

  /** Open a new tab in the persistent profile or in a fresh ephemeral context. */
  newTab(profile: BrowserProfileKind): ResultAsync<BrowserTab, Error> {
    return ResultAsync.fromPromise(
      (async () => {
        const ephemeralContext =
          profile === 'ephemeral'
            ? await this.browser.newContext({
                viewport: null,
                ...(this.userAgent ? { userAgent: this.userAgent } : {}),
              })
            : null;
        const context = ephemeralContext ?? this.browser.contexts()[0];
        if (!context) throw new Error('browser-unavailable: no default browser context');
        const page = await context.newPage();
        const cdp = await context.newCDPSession(page);
        const info = (await cdp.send('Target.getTargetInfo')) as {
          targetInfo: { targetId: string };
        };
        await cdp.detach().catch(() => {});
        return { page, targetId: info.targetInfo.targetId, ephemeralContext };
      })(),
      toError,
    );
  }

  /** Close a tab (and its ephemeral context). Never throws. */
  async closeTab(tab: BrowserTab): Promise<void> {
    await tab.page.close().catch(() => {});
    if (tab.ephemeralContext) await tab.ephemeralContext.close().catch(() => {});
  }

  get alive(): boolean {
    return this.proc.exitCode === null && !this.proc.killed;
  }

  /**
   * Disconnect Playwright and stop Chromium; resolves once the process has
   * exited, so the profile directory is no longer being written.
   */
  async shutdown(): Promise<void> {
    await this.browser.close().catch(() => {});
    if (this.proc.exitCode === null && !this.proc.killed) {
      this.proc.kill('SIGTERM');
      const force = setTimeout(() => {
        if (this.proc.exitCode === null) this.proc.kill('SIGKILL');
      }, 2000);
      force.unref?.();
      await this.exited;
      clearTimeout(force);
    }
  }
}
