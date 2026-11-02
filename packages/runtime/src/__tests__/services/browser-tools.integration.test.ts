/**
 * Agent browser tools end-to-end against a real headless Chromium and a local
 * fixture site: open → snapshot → fill/click by ref → stale refs → evaluate →
 * waits → dialogs → popups → thread isolation → panel input interleaving.
 * Skipped when no Playwright Chromium is installed.
 */

import { existsSync, rmSync } from 'fs';
import { createServer, type Server } from 'http';

import type { Result } from 'neverthrow';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const dataDir = vi.hoisted(() => {
  const dir = `${process.env.TMPDIR ?? '/tmp'}/funny-browser-tools-${Date.now()}`;
  process.env.FUNNY_DATA_DIR = dir;
  return dir;
});

vi.mock('../../lib/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../services/ws-broker.js', () => ({ wsBroker: { emitToUser: vi.fn() } }));

import { resolveChromiumBinary } from '../../services/browser-automation/browser-host.js';
import {
  browserAct,
  browserClose,
  browserEvaluate,
  browserNavigate,
  browserOpen,
  browserSnapshot,
  browserStatus,
  browserWaitFor,
  type BrowserToolContent,
} from '../../services/browser-automation/browser-tools.js';
import { browserSessionManager } from '../../services/browser-session-manager.js';

/** Value of an Ok result; fails the test with the error otherwise. */
function unwrap<T, E>(result: Result<T, E>): T {
  if (result.isErr()) throw new Error(`Expected ok, got ${JSON.stringify(result.error)}`);
  return result.value;
}

const binary = await resolveChromiumBinary().catch(() => null);
const describeWithChromium = binary && existsSync(binary) ? describe : describe.skip;

const PAGES: Record<string, string> = {
  '/login': `<title>Login</title>
    <form action="/done" method="get">
      <label>Email <input name="email"></label>
      <button type="submit">Sign in</button>
    </form>
    <button onclick="document.title = confirm('Delete?') ? 'yes' : 'no'">Danger</button>
    <a href="/popup" target="_blank">Open popup</a>
    <button onclick="setTimeout(() => document.body.insertAdjacentHTML('beforeend', '<p>Later</p>'), 300)">Delay</button>`,
  '/done': `<title>Done</title><h1>Welcome</h1>`,
  '/popup': `<title>Popup</title><h1>Popup page</h1>`,
};

function allText(content: BrowserToolContent[]): string {
  return content.map((c) => (c.type === 'text' ? c.text : '[image]')).join('\n');
}

function refOf(snapshot: string, pattern: RegExp): string {
  const match = pattern.exec(snapshot);
  if (!match) throw new Error(`No ref for ${pattern} in:\n${snapshot}`);
  return match[1];
}

describeWithChromium('agent browser tools (real Chromium)', () => {
  const ctx = { userId: 'user-1', threadId: 'thread-1' };
  let server: Server;
  let base: string;

  beforeAll(async () => {
    server = createServer((req, res) => {
      const path = (req.url ?? '/').split('?')[0];
      res.writeHead(PAGES[path] ? 200 : 404, { 'content-type': 'text/html' });
      res.end(PAGES[path] ?? 'not found');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  });

  afterAll(async () => {
    await browserSessionManager.closeAll();
    server?.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  test('tools other than open fail before a session exists', async () => {
    const result = await browserSnapshot(ctx, {});
    expect(result.isErr() && result.error.code).toBe('no-browser-session');
  });

  test('open, snapshot, fill and submit by ref', async () => {
    const opened = await browserOpen(ctx, { url: `${base}/login` });
    expect(allText(unwrap(opened))).toContain('Title: Login');

    const snap = allText(unwrap(await browserSnapshot(ctx, { screenshot: true })));
    expect(snap).toContain('[image]');
    const email = refOf(snap, /textbox "Email" \[ref=(e\d+)\]/);
    const submit = refOf(snap, /button "Sign in" \[ref=(e\d+)\]/);

    unwrap(await browserAct(ctx, { action: 'fill', ref: email, text: 'me@example.com' }));
    const clicked = allText(unwrap(await browserAct(ctx, { action: 'click', ref: submit })));
    expect(clicked).toContain('Title: Done');
    expect(clicked).toContain('email=me%40example.com');
    expect(clicked).toContain('The page navigated');

    // The old ref belonged to the login page snapshot.
    const stale = await browserAct(ctx, { action: 'click', ref: submit });
    expect(stale.isErr() && stale.error.code).toBe('stale-ref');
  }, 60_000);

  test('evaluate returns values and reports page exceptions', async () => {
    expect(allText(unwrap(await browserEvaluate(ctx, { expression: 'document.title' })))).toBe(
      '"Done"',
    );
    const thrown = await browserEvaluate(ctx, { expression: 'notDefinedAnywhere.x' });
    expect(thrown.isErr() && thrown.error.code).toBe('evaluate-failed');
    expect(thrown.isErr() && thrown.error.message).toContain('notDefinedAnywhere');
  });

  test('dialogs are dismissed and reported; waits resolve', async () => {
    unwrap(await browserNavigate(ctx, { url: `${base}/login` }));
    const snap = allText(unwrap(await browserSnapshot(ctx, {})));
    const danger = refOf(snap, /button "Danger" \[ref=(e\d+)\]/);
    const result = allText(unwrap(await browserAct(ctx, { action: 'click', ref: danger })));
    expect(result).toContain('confirm dialog ("Delete?") appeared and was dismissed');
    expect(result).toContain('Title: no');

    const delay = refOf(snap, /button "Delay" \[ref=(e\d+)\]/);
    unwrap(await browserAct(ctx, { action: 'click', ref: delay }));
    const waited = await browserWaitFor(ctx, { text: 'Later', timeoutMs: 5_000 });
    expect(allText(unwrap(waited))).toContain('Condition met');
  }, 60_000);

  test('popups become the active tab', async () => {
    const snap = allText(unwrap(await browserSnapshot(ctx, {})));
    const link = refOf(snap, /link "Open popup" \[ref=(e\d+)\]/);
    unwrap(await browserAct(ctx, { action: 'click', ref: link }));
    await vi.waitFor(
      () =>
        expect(browserSessionManager.findByThread(ctx.userId, ctx.threadId)?.url).toContain(
          '/popup',
        ),
      { timeout: 5_000 },
    );
    expect(allText(unwrap(await browserStatus(ctx)))).toContain('Title: Popup');
  }, 60_000);

  test('another thread cannot reach this session', async () => {
    const other = await browserSnapshot({ userId: 'user-1', threadId: 'thread-2' }, {});
    expect(other.isErr() && other.error.code).toBe('no-browser-session');
    const foreignUser = await browserSnapshot({ userId: 'user-2', threadId: 'thread-1' }, {});
    expect(foreignUser.isErr() && foreignUser.error.code).toBe('no-browser-session');
  });

  test('panel input and agent actions interleave without errors', async () => {
    unwrap(await browserNavigate(ctx, { url: `${base}/login` }));
    const snap = allText(unwrap(await browserSnapshot(ctx, {})));
    const email = refOf(snap, /textbox "Email" \[ref=(e\d+)\]/);
    const sessionId = `thread:${ctx.threadId}`;
    const moves = Array.from({ length: 20 }, (_, i) =>
      browserSessionManager.dispatchInput(ctx.userId, sessionId, {
        sessionId,
        kind: 'mouseMove',
        x: i * 10,
        y: i * 10,
      }),
    );
    const fill = browserAct(ctx, { action: 'fill', ref: email, text: 'together' });
    await Promise.all(moves);
    unwrap(await fill);
    const value = await browserEvaluate(ctx, {
      expression: "document.querySelector('input[name=email]').value",
    });
    expect(allText(unwrap(value))).toBe('"together"');
  }, 60_000);

  test('close ends the session', async () => {
    expect(allText(unwrap(await browserClose(ctx)))).toContain('closed');
    expect(browserSessionManager.findByThread(ctx.userId, ctx.threadId)).toBeNull();
  });
});
