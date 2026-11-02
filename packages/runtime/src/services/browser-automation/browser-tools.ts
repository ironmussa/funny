/**
 * Agent browser tools — the operations behind the `funny_browser` MCP server.
 *
 * Every function acts on the browser session bound to the calling spawn's
 * thread (`ctx.threadId`, `ctx.userId` come from the spawn closure, never from
 * the model). Actions run through Playwright on the same tab the Browser Panel
 * streams, serialised with panel input via `runExclusive`.
 *
 * Errors carry a stable code (`no-browser-session`, `stale-ref`, …) that the
 * MCP layer prefixes to the message so the agent can react to it.
 */

import {
  isAbsolute as isAbsolutePath,
  join as joinPath,
  relative as relativePath,
  resolve as resolvePath,
} from 'path';

import { ResultAsync } from 'neverthrow';
import type { Locator, Page } from 'playwright';
import { z } from 'zod';

import { log } from '../../lib/logger.js';
import { metric } from '../../lib/telemetry.js';
import { browserSessionManager, type BrowserSession } from '../browser-session-manager.js';
import type { ViewportRecorder } from './recorder.js';
import type { RefCheck } from './snapshot-refs.js';

const NS = 'browser-tools';
const ACTION_TIMEOUT_MS = 10_000;
const NAVIGATION_TIMEOUT_MS = 30_000;
const MAX_WAIT_MS = 60_000;
const MAX_SNAPSHOT_CHARS = 40_000;
const MAX_EVALUATE_CHARS = 20_000;

export type BrowserToolErrorCode =
  | 'no-browser-session'
  | 'stale-ref'
  | 'action-timeout'
  | 'evaluate-failed'
  | 'too-many-sessions'
  | 'browser-unavailable'
  | 'invalid-arguments'
  | 'action-failed'
  | 'user-has-control'
  | 'dialog-pending'
  | 'path-not-allowed'
  | 'recording-unavailable';

export interface BrowserToolError {
  code: BrowserToolErrorCode;
  message: string;
}

export type BrowserToolContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

export interface BrowserToolContext {
  userId: string;
  threadId: string;
  /** Thread working directory; `upload` only accepts files inside it. */
  cwd?: string;
  /** Per-user previewable assets dir; recordings are saved here. */
  assetsDir?: string;
}

type ToolResult = ResultAsync<BrowserToolContent[], BrowserToolError>;

class ToolFailure extends Error {
  constructor(
    readonly code: BrowserToolErrorCode,
    message: string,
  ) {
    super(message);
  }
}

function toToolError(err: unknown): BrowserToolError {
  if (err instanceof ToolFailure) return { code: err.code, message: err.message };
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof Error && err.name === 'TimeoutError') {
    return { code: 'action-timeout', message: firstLine(message) };
  }
  if (message.startsWith('too-many-sessions')) {
    return { code: 'too-many-sessions', message };
  }
  if (message.startsWith('browser-unavailable')) {
    return { code: 'browser-unavailable', message };
  }
  return { code: 'action-failed', message: firstLine(message) };
}

function firstLine(message: string): string {
  return message.split('\n')[0]?.slice(0, 500) ?? message;
}

function text(value: string): BrowserToolContent {
  return { type: 'text', text: value };
}

function run(
  tool: string,
  ctx: BrowserToolContext,
  fn: () => Promise<BrowserToolContent[]>,
): ToolResult {
  const started = Date.now();
  return ResultAsync.fromPromise(fn(), toToolError)
    .map((content) => {
      metric('browser_tool.calls', 1, { type: 'sum', attributes: { tool, outcome: 'ok' } });
      return content;
    })
    .mapErr((error) => {
      metric('browser_tool.calls', 1, { type: 'sum', attributes: { tool, outcome: error.code } });
      log.info('Browser tool failed', {
        namespace: NS,
        tool,
        threadId: ctx.threadId,
        code: error.code,
        ms: Date.now() - started,
      });
      return error;
    });
}

function requireSession(ctx: BrowserToolContext): BrowserSession {
  const s = browserSessionManager.findByThread(ctx.userId, ctx.threadId);
  if (!s) {
    throw new ToolFailure(
      'no-browser-session',
      'This thread has no open browser. Call browser_open first.',
    );
  }
  s.lastAgentActivity = Date.now();
  return s;
}

const STALE_REF_HINTS: Record<Exclude<RefCheck, { ok: true }>['reason'], string> = {
  'no-snapshot': 'No snapshot has been taken on this page yet.',
  'unknown-ref': 'That ref is not in the latest snapshot.',
  navigation: 'The page navigated since the last snapshot.',
  snapshot: 'That ref is not in the latest snapshot.',
  control: 'Control of the browser changed since the last snapshot.',
};

function locatorFor(s: BrowserSession, ref: string): Locator {
  const check = s.refs.check(ref);
  if (!check.ok) {
    throw new ToolFailure(
      'stale-ref',
      `Ref ${ref} is stale. ${STALE_REF_HINTS[check.reason]} Call browser_snapshot and use a ref from it.`,
    );
  }
  return s.tab.page.locator(`aria-ref=${ref}`);
}

function dialogNote(s: BrowserSession): string | null {
  const d = s.pendingDialog;
  if (!d) return null;
  return `A ${d.type} dialog is open: "${d.message.slice(0, 300)}". The page is frozen until you answer it with browser_dialog.`;
}

/** Page-changing tools wait while the user has taken the browser over. */
function requireAgentControl(s: BrowserSession): void {
  if (s.controller === 'user') {
    throw new ToolFailure(
      'user-has-control',
      'The user has taken control of the browser. Wait (browser_wait_for or browser_status) until they hand it back.',
    );
  }
}

/** Page tools cannot run while a JavaScript dialog freezes the page. */
function requireNoDialog(s: BrowserSession): void {
  const note = dialogNote(s);
  if (note) throw new ToolFailure('dialog-pending', note);
}

async function pageSummary(s: BrowserSession, extra: string[] = []): Promise<BrowserToolContent> {
  const page = s.tab.page;
  const note = dialogNote(s);
  // `title()` runs in the page, which a dialog freezes.
  const title = note ? '' : await page.title().catch(() => '');
  return text(
    [`URL: ${page.url()}`, `Title: ${title}`, ...extra, ...(note ? [note] : [])].join('\n'),
  );
}

/** Resolves when a dialog opens on the session (used to unblock in-flight actions). */
/**
 * Run `work` but return early if a JavaScript dialog opens meanwhile: the page
 * freezes until the dialog is answered, so the work cannot finish by itself.
 * The work keeps running and completes once the dialog is answered.
 */
async function untilDialog<T>(s: BrowserSession, work: Promise<T>): Promise<T | 'dialog'> {
  const dialog = nextDialog(s);
  work.catch(() => {});
  try {
    return await Promise.race([work, dialog.promise]);
  } finally {
    dialog.cancel();
  }
}

function nextDialog(s: BrowserSession): { promise: Promise<'dialog'>; cancel: () => void } {
  let listener: () => void = () => {};
  const promise = new Promise<'dialog'>((resolve) => {
    listener = () => resolve('dialog');
    s.signals.once('dialog', listener);
  });
  return { promise, cancel: () => s.signals.off('dialog', listener) };
}

/** Run an action and report whether the main frame navigated while it ran. */
async function trackNavigation(page: Page, fn: () => Promise<void>): Promise<boolean> {
  let navigated = false;
  const onNav = (frame: { parentFrame(): unknown }) => {
    if (!frame.parentFrame()) navigated = true;
  };
  page.on('framenavigated', onNav);
  try {
    await fn();
    // Give a click-triggered navigation a moment to start.
    await page.waitForLoadState('domcontentloaded', { timeout: 1_000 }).catch(() => {});
  } finally {
    page.off('framenavigated', onNav);
  }
  return navigated;
}

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:', 'about:', 'data:']);

/**
 * Accept web URLs only. Like the panel's URL bar, never hand Chromium a
 * scheme that could reach an OS handler or local resource (`file:`,
 * `javascript:`, `chrome:`, `apt:` …). Bare hosts get `https://`
 * (`http://` for localhost).
 */
export function normalizeUrl(input: string): string {
  const trimmed = input.trim();
  // `host:port` looks like a scheme to URL(); treat it as a bare host.
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) && !/^[^:/]+:\d/.test(trimmed);
  const isLocal = /^(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(trimmed);
  const withScheme = hasScheme ? trimmed : `${isLocal ? 'http' : 'https'}://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw new ToolFailure('invalid-arguments', `Not a valid URL: ${input}`);
  }
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    throw new ToolFailure(
      'invalid-arguments',
      `Only http(s), about: and data: URLs are allowed (got ${parsed.protocol}).`,
    );
  }
  return parsed.toString();
}

// ── Schemas (shared with the MCP server) ───────────────────────────────────

export const openArgs = {
  url: z.string().optional().describe('Page to load. Omit to just open/reuse the browser.'),
  profile: z
    .enum(['persistent', 'ephemeral'])
    .optional()
    .describe(
      'persistent (default) keeps logins across sessions; ephemeral starts clean and forgets everything on close. Only applies when a new session is created.',
    ),
};

export const navigateArgs = {
  url: z.string().optional().describe('URL to load.'),
  action: z
    .enum(['back', 'forward', 'reload'])
    .optional()
    .describe('History action instead of a URL.'),
};

export const snapshotArgs = {
  screenshot: z.boolean().optional().describe('Also return a screenshot of the viewport.'),
};

const pointArgs = z.object({ x: z.number(), y: z.number() });

export const actArgs = {
  action: z.enum([
    'click',
    'double_click',
    'hover',
    'type',
    'fill',
    'select',
    'press',
    'scroll',
    'drag',
    'upload',
  ]),
  ref: z.string().optional().describe('Element ref from the latest browser_snapshot, e.g. "e12".'),
  x: z.number().optional().describe('Viewport x coordinate (CSS px), used when no ref is given.'),
  y: z.number().optional().describe('Viewport y coordinate (CSS px), used when no ref is given.'),
  text: z.string().optional().describe('Text for type / fill.'),
  key: z.string().optional().describe('Key for press, e.g. "Enter", "Control+A".'),
  values: z.array(z.string()).optional().describe('Option values or labels for select.'),
  deltaX: z.number().optional().describe('Horizontal scroll amount in px.'),
  deltaY: z.number().optional().describe('Vertical scroll amount in px (positive scrolls down).'),
  paths: z
    .array(z.string())
    .optional()
    .describe(
      'Files for upload, relative to the thread working directory (files outside it are refused).',
    ),
  to: z
    .union([z.object({ ref: z.string() }), pointArgs])
    .optional()
    .describe('Drop target for drag: a ref or viewport coordinates.'),
};

export const evaluateArgs = {
  expression: z
    .string()
    .describe('JavaScript expression evaluated in the page. Promises are awaited.'),
};

export const waitForArgs = {
  text: z.string().optional().describe('Wait until this text is visible.'),
  textGone: z.string().optional().describe('Wait until this text is no longer visible.'),
  url: z.string().optional().describe('Wait until the URL contains this string.'),
  ref: z.string().optional().describe('Wait until this ref (latest snapshot) is visible.'),
  timeMs: z.number().optional().describe('Fixed delay instead of a condition.'),
  timeoutMs: z.number().optional().describe('Maximum wait (default 10000, max 60000).'),
};

export const resizeArgs = {
  width: z.number().int().min(200).max(3840),
  height: z.number().int().min(200).max(2160),
};

type Args<T extends Record<string, z.ZodTypeAny>> = z.infer<z.ZodObject<T>>;

// ── Tools ──────────────────────────────────────────────────────────────────

export function browserOpen(ctx: BrowserToolContext, args: Args<typeof openArgs>): ToolResult {
  return run('browser_open', ctx, async () => {
    const url = args.url ? normalizeUrl(args.url) : '';
    const existing = browserSessionManager.findByThread(ctx.userId, ctx.threadId);
    const s =
      existing && !url
        ? existing
        : await browserSessionManager.openForThread(ctx.userId, ctx.threadId, url, args.profile);
    if (!s) throw new ToolFailure('no-browser-session', 'Could not open a browser session.');
    s.lastAgentActivity = Date.now();
    const note =
      existing && args.profile && args.profile !== existing.profile
        ? [
            `Note: reused the existing ${existing.profile} session; close it first to switch profile.`,
          ]
        : [];
    return [
      await pageSummary(s, [
        `Profile: ${s.profile}`,
        ...note,
        'The user can watch this browser in the Funny browser panel.',
      ]),
    ];
  }).mapErr((error) => {
    if (error.code !== 'too-many-sessions') return error;
    const holders = browserSessionManager.listThreadsWithSessions(ctx.userId);
    return {
      code: error.code,
      message: `The runner has too many open browser sessions${holders.length ? ` (threads: ${holders.join(', ')})` : ''}. Ask the user to close one.`,
    };
  });
}

export function browserNavigate(
  ctx: BrowserToolContext,
  args: Args<typeof navigateArgs>,
): ToolResult {
  return run('browser_navigate', ctx, async () => {
    const s = requireSession(ctx);
    requireAgentControl(s);
    requireNoDialog(s);
    if (!args.url && !args.action) {
      throw new ToolFailure('invalid-arguments', 'Pass either url or action.');
    }
    await browserSessionManager.runExclusive(s, async () => {
      const page = s.tab.page;
      if (args.url) {
        await page.goto(normalizeUrl(args.url), {
          waitUntil: 'domcontentloaded',
          timeout: NAVIGATION_TIMEOUT_MS,
        });
      } else if (args.action === 'back') {
        await page.goBack({ waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS });
      } else if (args.action === 'forward') {
        await page.goForward({ waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS });
      } else {
        await page.reload({ waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS });
      }
    });
    return [await pageSummary(s)];
  });
}

export function browserSnapshot(
  ctx: BrowserToolContext,
  args: Args<typeof snapshotArgs>,
): ToolResult {
  return run('browser_snapshot', ctx, async () => {
    const s = requireSession(ctx);
    requireNoDialog(s);
    return browserSessionManager.runExclusive(s, async () => {
      const page = s.tab.page;
      const raw = await page.ariaSnapshot({ mode: 'ai', timeout: ACTION_TIMEOUT_MS });
      s.refs.recordSnapshot(raw);
      const snapshot =
        raw.length > MAX_SNAPSHOT_CHARS
          ? `${raw.slice(0, MAX_SNAPSHOT_CHARS)}\n[truncated — scroll, or use browser_evaluate to inspect a specific part]`
          : raw;
      const content: BrowserToolContent[] = [
        await pageSummary(s),
        text(`Snapshot (use the [ref=…] ids with browser_act):\n${snapshot}`),
      ];
      if (args.screenshot) {
        const shot = await page.screenshot({
          type: 'jpeg',
          quality: 70,
          timeout: ACTION_TIMEOUT_MS,
        });
        content.push({ type: 'image', data: shot.toString('base64'), mimeType: 'image/jpeg' });
      }
      return content;
    });
  });
}

function requirePoint(args: { x?: number; y?: number }, action: string): { x: number; y: number } {
  if (args.x === undefined || args.y === undefined) {
    throw new ToolFailure('invalid-arguments', `${action} needs a ref or both x and y.`);
  }
  return { x: args.x, y: args.y };
}

type ActArgs = Args<typeof actArgs>;

/** What an action handler gets: the page, the resolved ref (if any) and a label for messages. */
interface ActionContext {
  s: BrowserSession;
  page: Page;
  target: Locator | null;
  label: string;
  args: ActArgs;
  /** Thread working directory (upload sandbox). */
  cwd?: string;
}

const timeout = ACTION_TIMEOUT_MS;

function requireTarget(ctx: ActionContext): Locator {
  if (!ctx.target) {
    throw new ToolFailure('invalid-arguments', `${ctx.args.action} needs a ref.`);
  }
  return ctx.target;
}

function requireText(ctx: ActionContext): string {
  if (ctx.args.text === undefined) {
    throw new ToolFailure('invalid-arguments', `${ctx.args.action} needs text.`);
  }
  return ctx.args.text;
}

async function centerOf(locator: Locator): Promise<{ x: number; y: number } | null> {
  const box = await locator.boundingBox({ timeout });
  return box ? { x: box.x + box.width / 2, y: box.y + box.height / 2 } : null;
}

async function clickAction(ctx: ActionContext, clickCount: 1 | 2): Promise<string> {
  if (ctx.target) {
    await (clickCount === 2 ? ctx.target.dblclick({ timeout }) : ctx.target.click({ timeout }));
  } else {
    const p = requirePoint(ctx.args, ctx.args.action);
    await ctx.page.mouse.click(p.x, p.y, { clickCount });
  }
  return `${clickCount === 2 ? 'Double-clicked' : 'Clicked'} ${ctx.label}.`;
}

async function hoverAction(ctx: ActionContext): Promise<string> {
  if (ctx.target) await ctx.target.hover({ timeout });
  else {
    const p = requirePoint(ctx.args, 'hover');
    await ctx.page.mouse.move(p.x, p.y);
  }
  return `Hovered ${ctx.label}.`;
}

async function typeAction(ctx: ActionContext): Promise<string> {
  const text = requireText(ctx);
  if (ctx.target) await ctx.target.pressSequentially(text, { timeout });
  else await ctx.page.keyboard.type(text);
  return `Typed ${text.length} characters${ctx.target ? ` into ${ctx.label}` : ''}.`;
}

async function fillAction(ctx: ActionContext): Promise<string> {
  await requireTarget(ctx).fill(requireText(ctx), { timeout });
  return `Filled ${ctx.label}.`;
}

async function selectAction(ctx: ActionContext): Promise<string> {
  const target = requireTarget(ctx);
  if (!ctx.args.values?.length) throw new ToolFailure('invalid-arguments', 'select needs values.');
  const selected = await target.selectOption(ctx.args.values, { timeout });
  return `Selected ${selected.join(', ')} in ${ctx.label}.`;
}

async function pressAction(ctx: ActionContext): Promise<string> {
  const key = ctx.args.key;
  if (!key) throw new ToolFailure('invalid-arguments', 'press needs key.');
  if (ctx.target) await ctx.target.press(key, { timeout });
  else await ctx.page.keyboard.press(key);
  return `Pressed ${key}${ctx.target ? ` on ${ctx.label}` : ''}.`;
}

async function scrollAction(ctx: ActionContext): Promise<string> {
  const { args, page } = ctx;
  let at: { x: number; y: number } | null = null;
  if (ctx.target) {
    await ctx.target.scrollIntoViewIfNeeded({ timeout });
    at = await centerOf(ctx.target);
  } else if (args.x !== undefined && args.y !== undefined) {
    at = { x: args.x, y: args.y };
  }
  if (at) await page.mouse.move(at.x, at.y);
  const dx = args.deltaX ?? 0;
  const dy = args.deltaY ?? 0;
  await page.mouse.wheel(dx, dy);
  return `Scrolled${at ? ` at ${ctx.label}` : ''} by (${dx}, ${dy}).`;
}

async function dragAction(ctx: ActionContext): Promise<string> {
  const to = ctx.args.to;
  if (!to) throw new ToolFailure('invalid-arguments', 'drag needs to.');
  if (ctx.target && 'ref' in to) {
    await ctx.target.dragTo(locatorFor(ctx.s, to.ref), { timeout });
    return `Dragged ${ctx.label}.`;
  }
  const start = ctx.target ? await centerOf(ctx.target) : requirePoint(ctx.args, 'drag');
  const end = 'ref' in to ? await centerOf(locatorFor(ctx.s, to.ref)) : to;
  if (!start || !end)
    throw new ToolFailure('action-failed', 'Drag source or target is not visible.');
  await ctx.page.mouse.move(start.x, start.y);
  await ctx.page.mouse.down();
  await ctx.page.mouse.move(end.x, end.y, { steps: 10 });
  await ctx.page.mouse.up();
  return `Dragged ${ctx.label}.`;
}

/** Resolve upload paths inside the thread directory; anything else is refused. */
function resolveUploadPaths(cwd: string | undefined, paths: string[]): string[] {
  if (!cwd) {
    throw new ToolFailure(
      'path-not-allowed',
      'This thread has no working directory to upload from.',
    );
  }
  const root = resolvePath(cwd);
  return paths.map((p) => {
    const abs = resolvePath(root, p);
    const rel = relativePath(root, abs);
    if (rel.startsWith('..') || isAbsolutePath(rel)) {
      throw new ToolFailure('path-not-allowed', `${p} is outside the thread directory (${root}).`);
    }
    return abs;
  });
}

async function uploadAction(ctx: ActionContext): Promise<string> {
  const target = requireTarget(ctx);
  if (!ctx.args.paths?.length) throw new ToolFailure('invalid-arguments', 'upload needs paths.');
  const files = resolveUploadPaths(ctx.cwd, ctx.args.paths);
  await target.setInputFiles(files, { timeout });
  return `Attached ${files.length} file(s) to ${ctx.label}.`;
}

const ACTIONS: Record<ActArgs['action'], (ctx: ActionContext) => Promise<string>> = {
  click: (ctx) => clickAction(ctx, 1),
  double_click: (ctx) => clickAction(ctx, 2),
  hover: hoverAction,
  type: typeAction,
  fill: fillAction,
  select: selectAction,
  press: pressAction,
  scroll: scrollAction,
  drag: dragAction,
  upload: uploadAction,
};

function performAction(
  s: BrowserSession,
  args: ActArgs,
  toolCtx: BrowserToolContext,
): Promise<string> {
  const ctx: ActionContext = {
    s,
    page: s.tab.page,
    target: args.ref ? locatorFor(s, args.ref) : null,
    label: args.ref ? `ref ${args.ref}` : `(${args.x}, ${args.y})`,
    args,
    cwd: toolCtx.cwd,
  };
  return ACTIONS[args.action](ctx);
}

export function browserAct(ctx: BrowserToolContext, args: Args<typeof actArgs>): ToolResult {
  return run('browser_act', ctx, async () => {
    const s = requireSession(ctx);
    requireAgentControl(s);
    requireNoDialog(s);
    let description = '';
    const outcome = await untilDialog(
      s,
      browserSessionManager.runExclusive(s, () =>
        trackNavigation(s.tab.page, async () => {
          description = await performAction(s, args, ctx);
        }),
      ),
    );
    if (outcome === 'dialog') return [await pageSummary(s, [`${args.action} triggered a dialog.`])];
    const navigated = outcome;
    return [
      await pageSummary(
        s,
        [
          description,
          navigated ? 'The page navigated; refs from earlier snapshots are now stale.' : '',
        ].filter(Boolean),
      ),
    ];
  });
}

export function browserEvaluate(
  ctx: BrowserToolContext,
  args: Args<typeof evaluateArgs>,
): ToolResult {
  return run('browser_evaluate', ctx, async () => {
    const s = requireSession(ctx);
    requireAgentControl(s);
    requireNoDialog(s);
    let value: unknown;
    try {
      // A string is evaluated as an expression through CDP (not page `eval`,
      // which a strict CSP would block); a returned promise is awaited.
      value = await untilDialog(
        s,
        browserSessionManager.runExclusive(s, () => s.tab.page.evaluate(args.expression)),
      );
    } catch (err) {
      throw new ToolFailure(
        'evaluate-failed',
        firstLine(err instanceof Error ? err.message : String(err)),
      );
    }
    let serialized = value === undefined ? 'undefined' : JSON.stringify(value, null, 2);
    if (serialized === undefined) serialized = String(value);
    if (serialized.length > MAX_EVALUATE_CHARS) {
      serialized = `${serialized.slice(0, MAX_EVALUATE_CHARS)}\n[truncated]`;
    }
    const note = dialogNote(s);
    return [text(value === 'dialog' && note ? note : serialized)];
  });
}

export function browserWaitFor(
  ctx: BrowserToolContext,
  args: Args<typeof waitForArgs>,
): ToolResult {
  return run('browser_wait_for', ctx, async () => {
    const s = requireSession(ctx);
    const page = s.tab.page;
    const timeout = Math.min(args.timeoutMs ?? ACTION_TIMEOUT_MS, MAX_WAIT_MS);
    // Waits do not take the action lock, so the user (or panel) can keep
    // interacting while the agent polls.
    if (args.timeMs !== undefined) {
      await page.waitForTimeout(Math.min(args.timeMs, MAX_WAIT_MS));
    } else if (args.text) {
      await page.getByText(args.text).first().waitFor({ state: 'visible', timeout });
    } else if (args.textGone) {
      await page.getByText(args.textGone).first().waitFor({ state: 'hidden', timeout });
    } else if (args.url) {
      const needle = args.url;
      await page.waitForURL((u) => u.toString().includes(needle), { timeout });
    } else if (args.ref) {
      await locatorFor(s, args.ref).waitFor({ state: 'visible', timeout });
    } else {
      throw new ToolFailure('invalid-arguments', 'Pass one of text, textGone, url, ref or timeMs.');
    }
    return [await pageSummary(s, ['Condition met.'])];
  });
}

export function browserStatus(ctx: BrowserToolContext): ToolResult {
  return run('browser_status', ctx, async () => {
    const s = browserSessionManager.findByThread(ctx.userId, ctx.threadId);
    if (!s) return [text('No browser session is open for this thread. Call browser_open.')];
    const errors = s.consoleErrors.slice(-5);
    return [
      await pageSummary(
        s,
        [
          'Open: yes',
          `Profile: ${s.profile}`,
          `Viewport: ${s.viewport.width}x${s.viewport.height}`,
          `Controller: ${s.controller}`,
          `Panel attached: ${s.panelAttached ? 'yes' : 'no'}`,
          s.recorder ? `Recording: yes (${s.recorder.frameCount} frames)` : '',
          errors.length ? `Recent page errors:\n${errors.map((e) => `- ${e}`).join('\n')}` : '',
        ].filter(Boolean),
      ),
    ];
  });
}

export function browserResize(ctx: BrowserToolContext, args: Args<typeof resizeArgs>): ToolResult {
  return run('browser_resize', ctx, async () => {
    const s = requireSession(ctx);
    requireAgentControl(s);
    await browserSessionManager.runExclusive(s, () =>
      browserSessionManager.setViewport(s, args.width, args.height),
    );
    return [await pageSummary(s, [`Viewport: ${args.width}x${args.height}`])];
  });
}

export function browserClose(ctx: BrowserToolContext): ToolResult {
  return run('browser_close', ctx, async () => {
    const s = browserSessionManager.findByThread(ctx.userId, ctx.threadId);
    if (!s) return [text('No browser session was open.')];
    await browserSessionManager.close(s.sessionId, 'user');
    return [text('Browser session closed.')];
  });
}

// ── Dialogs, appearance, recording ────────────────────────────────────────

export const dialogArgs = {
  accept: z.boolean().describe('true accepts (OK), false dismisses (Cancel).'),
  promptText: z.string().optional().describe('Answer for a prompt() dialog.'),
};

export const appearanceArgs = {
  colorScheme: z.enum(['light', 'dark']).describe('Preferred colour scheme to emulate.'),
};

export function browserDialog(ctx: BrowserToolContext, args: Args<typeof dialogArgs>): ToolResult {
  return run('browser_dialog', ctx, async () => {
    const s = requireSession(ctx);
    requireAgentControl(s);
    const pending = s.pendingDialog;
    // Not queued: the action that opened the dialog still holds the queue.
    if (!pending || !(await browserSessionManager.answerDialog(s, args.accept, args.promptText))) {
      throw new ToolFailure('invalid-arguments', 'No dialog is open.');
    }
    return [
      await pageSummary(s, [
        `${args.accept ? 'Accepted' : 'Dismissed'} the ${pending.type} dialog "${pending.message.slice(0, 200)}".`,
      ]),
    ];
  });
}

export function browserSetAppearance(
  ctx: BrowserToolContext,
  args: Args<typeof appearanceArgs>,
): ToolResult {
  return run('browser_set_appearance', ctx, async () => {
    const s = requireSession(ctx);
    requireAgentControl(s);
    requireNoDialog(s);
    await browserSessionManager.runExclusive(s, () =>
      s.tab.page.emulateMedia({ colorScheme: args.colorScheme }),
    );
    return [await pageSummary(s, [`Colour scheme: ${args.colorScheme}`])];
  });
}

export function browserRecordingStart(ctx: BrowserToolContext): ToolResult {
  return run('browser_recording_start', ctx, async () => {
    const s = requireSession(ctx);
    if (s.recorder) return [text('A recording is already running. Call browser_recording_stop.')];
    const { hasFfmpeg, ViewportRecorder } = await import('./recorder.js');
    if (!ctx.assetsDir || !(await hasFfmpeg())) {
      throw new ToolFailure(
        'recording-unavailable',
        'Recording needs ffmpeg (with libx264) on the runner and an assets directory.',
      );
    }
    s.recorder = await ViewportRecorder.start();
    // Static pages do not repaint: seed the recording with the current view.
    const first = await browserSessionManager.captureFrame(s);
    if (first) s.recorder.addFrame(first.data, first.timestamp);
    return [text('Recording the browser viewport. Call browser_recording_stop to save it.')];
  });
}

export function browserRecordingStop(ctx: BrowserToolContext): ToolResult {
  return run('browser_recording_stop', ctx, async () => {
    const s = requireSession(ctx);
    const recorder: ViewportRecorder | null = s.recorder;
    if (!recorder) throw new ToolFailure('invalid-arguments', 'No recording is running.');
    const last = await browserSessionManager.captureFrame(s);
    if (last) recorder.addFrame(last.data, last.timestamp);
    s.recorder = null;
    const out = joinPath(
      ctx.assetsDir ?? '',
      `browser-recording-${ctx.threadId.slice(0, 8)}-${Date.now()}.mp4`,
    );
    const result = await recorder.stop(out);
    if (result.isErr()) throw new ToolFailure('action-failed', result.error.message);
    const { path, frames, seconds } = result.value;
    return [text(`Recording saved: ${path}\n${seconds}s, ${frames} frames.`)];
  });
}
