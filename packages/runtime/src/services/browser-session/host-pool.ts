/**
 * One headless Chromium per user, shared by that user's sessions: launched on
 * first use (concurrent callers share one launch), kept warm briefly after
 * its last session closes. Split out of browser-session-manager.ts.
 */

import type { Page } from 'playwright';

import {
  BrowserHost,
  profileDirFor,
  resolveChromiumBinary,
} from '../browser-automation/browser-host.js';
import { installPageAudio } from '../browser-automation/page-audio.js';
import { VIEWPORT_HEIGHT, VIEWPORT_WIDTH } from './session-record.js';

const BASE_PORT = 9300; // test-runner uses 9223; keep us out of that range
/** Keep Chromium warm briefly after its last tab closes. */
const HOST_GRACE_MS = 30_000;

interface HostEntry {
  host: BrowserHost | null;
  launching: Promise<BrowserHost> | null;
  graceTimer: ReturnType<typeof setTimeout> | null;
}

export class BrowserHostPool {
  private hosts = new Map<string, HostEntry>();

  constructor(
    private readonly hooks: {
      /** Whether the user still has an open session. */
      userHasSessions(userId: string): boolean;
      /** The user's Chromium exited; the pool has already forgotten it. */
      onHostExit(userId: string, detail: string): void;
      /** The audio setting of the session that owns a page. */
      pageAudioMuted(page: Page): boolean;
    },
  ) {}

  private async allocatePort(): Promise<number> {
    const { findAvailablePort } = await import('@funny/core/ports');
    const used = new Set<number>();
    for (const entry of this.hosts.values()) if (entry.host) used.add(entry.host.port);
    return findAvailablePort(BASE_PORT, used);
  }

  /** The user's Chromium host, launching it if needed (concurrent callers share one launch). */
  async hostFor(userId: string): Promise<BrowserHost> {
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
      // Safety net: every page of the profile is held muted from its first
      // script, even one no session tracks (it would play on the runner host).
      result.value.browser.contexts()[0]?.on('page', (page) => {
        void installPageAudio(page, () => this.hooks.pageAudioMuted(page)).catch(() => {});
      });
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
    this.hooks.onHostExit(userId, detail);
  }

  scheduleShutdownIfUnused(userId: string): void {
    const entry = this.hosts.get(userId);
    if (!entry?.host) return;
    if (this.hooks.userHasSessions(userId) || entry.graceTimer) return;
    entry.graceTimer = setTimeout(() => {
      entry.graceTimer = null;
      if (!this.hooks.userHasSessions(userId) && entry.host) {
        const host = entry.host;
        entry.host = null;
        void host.shutdown();
      }
    }, HOST_GRACE_MS);
    entry.graceTimer.unref?.();
  }

  /** Shut the user's Chromium down now (waiting for a launch in flight) and forget it. */
  async shutdownUser(userId: string): Promise<void> {
    const entry = this.hosts.get(userId);
    if (entry?.launching) await entry.launching.catch(() => {});
    if (entry?.graceTimer) clearTimeout(entry.graceTimer);
    if (entry?.host) await entry.host.shutdown();
    this.hosts.delete(userId);
  }

  /** Shut every Chromium down — used on runner shutdown. */
  async shutdownAll(): Promise<void> {
    const hosts = Array.from(this.hosts.values());
    this.hosts.clear();
    await Promise.all(
      hosts.map(async (entry) => {
        if (entry.graceTimer) clearTimeout(entry.graceTimer);
        await entry.host?.shutdown();
      }),
    );
  }
}
