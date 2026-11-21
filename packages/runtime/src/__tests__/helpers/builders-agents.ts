/**
 * Test helpers for the agent lifecycle, runner and browser-automation tests.
 */

import { expect, vi } from 'bun:test';
import { EventEmitter } from 'node:events';

import type { IAgentProcess } from '@funny/core/agents';
import { ChromeSession } from '@funny/core/chrome';
import type { Page } from 'playwright';

import type { BrowserHost, BrowserTab } from '../../services/browser-automation/browser-host.js';
import { RefGenerations } from '../../services/browser-automation/snapshot-refs.js';
import type { BrowserSession } from '../../services/browser-session-manager.js';

/**
 * An agent process that never spawns anything. `threadId` only labels it in
 * assertions; `exited` can be set to model a process that already died.
 */
export class FakeAgentProcess extends EventEmitter implements IAgentProcess {
  exited: boolean;

  constructor(
    readonly threadId = 'thread-1',
    opts: { exited?: boolean } = {},
  ) {
    super();
    this.exited = opts.exited ?? false;
  }

  start(): void {}

  async kill(): Promise<void> {
    this.exited = true;
  }
}

/**
 * Replaces methods (or public fields) of a real instance with test doubles.
 * `Partial<T>` checks each replacement against the real member's type, so the
 * result is still a genuine `T` (class identity, private state) whose chosen
 * members are mocks.
 */
export function stubMethods<T extends object>(target: T, members: Partial<T>): T {
  return Object.assign(target, members);
}

/** Asserts `value` is neither `undefined` nor `null` and narrows it. */
export function expectDefined<T>(value: T | null | undefined): T {
  expect(value).toBeDefined();
  expect(value).not.toBeNull();
  if (value === undefined || value === null) throw new Error('expected a value');
  return value;
}

// ── Browser automation ─────────────────────────────────────────

/**
 * A `BrowserHost` exposing only `members`. The real one owns a live Chromium
 * process behind a private constructor, so it cannot be built in a unit test.
 */
export function fakeBrowserHost(members: Partial<BrowserHost> = {}): BrowserHost {
  // SAFETY: session-manager tests never launch Chromium; the code under test only
  // reaches the host members each test passes in `members` (port, closeTab).
  return members as BrowserHost;
}

/** A Playwright `Page` exposing only `members`; the code under test must not reach others. */
function fakePage(members: Partial<Page> = {}): Page {
  // SAFETY: Playwright's Page is a large live-browser interface; these tests only
  // store the page on a tab and never drive it beyond the members passed in.
  return members as Page;
}

export function buildBrowserTab(overrides: Partial<BrowserTab> = {}): BrowserTab {
  return { page: fakePage(), targetId: 't', ephemeralContext: null, ...overrides };
}

/** A real (never connected) `ChromeSession` whose chosen members are test doubles. */
export function stubChromeSession(members: Partial<ChromeSession> = {}): ChromeSession {
  return stubMethods(new ChromeSession(), members);
}

/** A panel-owned browser session with every required field defaulted. */
export function buildBrowserSession(overrides: Partial<BrowserSession> = {}): BrowserSession {
  return {
    sessionId: 'panel-1',
    userId: 'u1',
    threadId: null,
    owner: 'panel',
    profile: 'persistent',
    url: 'about:blank',
    host: fakeBrowserHost({ port: 9300, closeTab: vi.fn(async () => {}) }),
    tab: buildBrowserTab(),
    backgroundTabs: [],
    chromeSession: stubChromeSession({ disconnect: vi.fn(async () => {}) }),
    viewport: { width: 1920, height: 1080 },
    lastHeartbeat: 0,
    panelAttached: true,
    lastAgentActivity: 0,
    controller: 'agent',
    audioMuted: false,
    refs: new RefGenerations(),
    pendingDialog: null,
    recorder: null,
    signals: new EventEmitter(),
    consoleErrors: [],
    queue: Promise.resolve(),
    ...overrides,
  };
}
