/**
 * Agent browser tools end-to-end against a real headless Chromium and a local
 * fixture site: open → snapshot → fill/click by ref → stale refs → evaluate →
 * waits → dialogs → popups → thread isolation → panel input interleaving.
 * Skipped when no Playwright Chromium is installed.
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { createServer, type Server } from 'http';
import { tmpdir } from 'os';
import { join } from 'path';

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
  browserResize,
  browserSnapshot,
  browserStatus,
  browserWaitFor,
  browserDialog,
  browserRecordingStart,
  browserRecordingStop,
  browserSetAppearance,
  type BrowserToolContent,
} from '../../services/browser-automation/browser-tools.js';
import { browserSessionManager } from '../../services/browser-session-manager.js';
import { wsBroker } from '../../services/ws-broker.js';

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
  '/audio': `<title>Audio</title><audio id="a" loop></audio>
    <iframe srcdoc="<audio id='b'></audio>"></iframe>`,
  '/popup': `<title>Popup</title><h1>Popup page</h1>`,
  '/upload': `<title>Upload</title><label>File <input type="file" id="f"></label>`,
  // Animated so the screencast keeps sending frames.
  '/keys': `<title>Keys</title><input id="k" value="hello world">
    <style>@keyframes pulse { to { opacity: 0.9 } } body { animation: pulse 0.1s infinite alternate }</style>`,
};

/** Width and height of a base64 JPEG (from its SOF marker). */
function jpegSize(base64: string): { width: number; height: number } | null {
  const bytes = Buffer.from(base64, 'base64');
  for (let i = 2; i + 9 < bytes.length;) {
    if (bytes[i] !== 0xff) return null;
    const marker = bytes[i + 1];
    if (marker >= 0xc0 && marker <= 0xc3) {
      return { height: bytes.readUInt16BE(i + 5), width: bytes.readUInt16BE(i + 7) };
    }
    i += 2 + bytes.readUInt16BE(i + 2);
  }
  return null;
}

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

  test('dialogs are held until answered; waits resolve', async () => {
    unwrap(await browserNavigate(ctx, { url: `${base}/login` }));
    const snap = allText(unwrap(await browserSnapshot(ctx, {})));
    const danger = refOf(snap, /button "Danger" \[ref=(e\d+)\]/);
    const result = allText(unwrap(await browserAct(ctx, { action: 'click', ref: danger })));
    expect(result).toContain('A confirm dialog is open: "Delete?"');

    // Page tools refuse while the dialog freezes the page.
    const blocked = await browserSnapshot(ctx, {});
    expect(blocked.isErr() && blocked.error.code).toBe('dialog-pending');

    const answered = allText(unwrap(await browserDialog(ctx, { accept: true })));
    expect(answered).toContain('Accepted the confirm dialog');
    await vi.waitFor(async () =>
      expect(allText(unwrap(await browserEvaluate(ctx, { expression: 'document.title' })))).toBe(
        '"yes"',
      ),
    );

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

  test('the user can take control; agent page tools wait until handed back', async () => {
    unwrap(await browserNavigate(ctx, { url: `${base}/login` }));
    const snap = allText(unwrap(await browserSnapshot(ctx, {})));
    const email = refOf(snap, /textbox "Email" \[ref=(e\d+)\]/);
    const sessionId = `thread:${ctx.threadId}`;
    await browserSessionManager.dispatchInput(ctx.userId, sessionId, {
      sessionId,
      kind: 'takeControl',
    });

    const blocked = await browserAct(ctx, { action: 'fill', ref: email, text: 'x' });
    expect(blocked.isErr() && blocked.error.code).toBe('user-has-control');
    // Read-only tools keep working.
    expect(allText(unwrap(await browserStatus(ctx)))).toContain('Controller: user');

    await browserSessionManager.dispatchInput(ctx.userId, sessionId, {
      sessionId,
      kind: 'releaseControl',
    });
    // Refs taken before the change of control are stale.
    const stale = await browserAct(ctx, { action: 'fill', ref: email, text: 'x' });
    expect(stale.isErr() && stale.error.code).toBe('stale-ref');
  }, 60_000);

  test('the panel can answer a dialog', async () => {
    const snap = allText(unwrap(await browserSnapshot(ctx, {})));
    const danger = refOf(snap, /button "Danger" \[ref=(e\d+)\]/);
    unwrap(await browserAct(ctx, { action: 'click', ref: danger }));
    const sessionId = `thread:${ctx.threadId}`;
    await browserSessionManager.dispatchInput(ctx.userId, sessionId, {
      sessionId,
      kind: 'dialog',
      accept: false,
    });
    await vi.waitFor(async () =>
      expect(allText(unwrap(await browserEvaluate(ctx, { expression: 'document.title' })))).toBe(
        '"no"',
      ),
    );
  }, 60_000);

  test('a re-attaching panel is told the controller and the pending dialog', async () => {
    const snap = allText(unwrap(await browserSnapshot(ctx, {})));
    const danger = refOf(snap, /button "Danger"[^\n]*\[ref=(e\d+)\]/);
    unwrap(await browserAct(ctx, { action: 'click', ref: danger }));
    const sessionId = `thread:${ctx.threadId}`;
    await browserSessionManager.dispatchInput(ctx.userId, sessionId, {
      sessionId,
      kind: 'takeControl',
    });
    const emitToUser = vi.mocked(wsBroker.emitToUser);
    emitToUser.mockClear();

    await browserSessionManager.open(ctx.userId, sessionId, '');
    const sent = emitToUser.mock.calls.map(([, event]) => event as { type: string; data: unknown });
    expect(sent).toContainEqual(
      expect.objectContaining({
        type: 'browser-session:controller',
        data: expect.objectContaining({ controller: 'user' }),
      }),
    );
    expect(sent).toContainEqual(
      expect.objectContaining({
        type: 'browser-session:dialog',
        data: expect.objectContaining({ dialog: expect.objectContaining({ type: 'confirm' }) }),
      }),
    );

    await browserSessionManager.dispatchInput(ctx.userId, sessionId, {
      sessionId,
      kind: 'dialog',
      accept: false,
    });
    await browserSessionManager.dispatchInput(ctx.userId, sessionId, {
      sessionId,
      kind: 'releaseControl',
    });
  }, 60_000);

  test('screencast frames have the viewport size, also after a resize', async () => {
    unwrap(await browserNavigate(ctx, { url: `${base}/keys` }));
    const sessionId = `thread:${ctx.threadId}`;
    const emitToUser = vi.mocked(wsBroker.emitToUser);
    const lastFrameSize = async () => {
      emitToUser.mockClear();
      await new Promise((r) => setTimeout(r, 800));
      const frames = emitToUser.mock.calls
        .map(([, event]) => event as { type: string; data: { sessionId: string; data: string } })
        .filter((e) => e.type === 'browser-session:frame' && e.data.sessionId === sessionId);
      return frames.length ? jpegSize(frames.at(-1)!.data.data) : null;
    };

    // Headless Chrome's UI used to eat ~143px: frames came out 1920×937 and
    // the panel stretched them, so clicks landed below the pointer.
    expect(await lastFrameSize()).toEqual({ width: 1920, height: 1080 });
    unwrap(await browserResize(ctx, { width: 1280, height: 720 }));
    expect(await lastFrameSize()).toEqual({ width: 1280, height: 720 });
    unwrap(await browserResize(ctx, { width: 1920, height: 1080 }));
  }, 60_000);

  test('panel keystrokes: arrows, Shift+arrows and Backspace edit the field', async () => {
    unwrap(await browserNavigate(ctx, { url: `${base}/keys` }));
    unwrap(
      await browserEvaluate(ctx, {
        expression:
          "(() => { const k = document.getElementById('k'); k.focus(); k.setSelectionRange(11, 11); })()",
      }),
    );
    const sessionId = `thread:${ctx.threadId}`;
    const press = async (key: string, code: string, keyCode: number, modifiers = 0) => {
      for (const kind of ['keyDown', 'keyUp'] as const) {
        await browserSessionManager.dispatchInput(ctx.userId, sessionId, {
          sessionId,
          kind,
          key,
          code,
          keyCode,
          modifiers,
        });
      }
    };
    await press('ArrowLeft', 'ArrowLeft', 37);
    await press('ArrowLeft', 'ArrowLeft', 37, 8); // Shift
    await press('ArrowLeft', 'ArrowLeft', 37, 8);
    expect(
      allText(
        unwrap(
          await browserEvaluate(ctx, {
            expression:
              "[document.getElementById('k').selectionStart, document.getElementById('k').selectionEnd]",
          }),
        ),
      ),
    ).toMatch(/8,\s*10/);
    await press('Backspace', 'Backspace', 8);
    expect(
      allText(
        unwrap(await browserEvaluate(ctx, { expression: "document.getElementById('k').value" })),
      ),
    ).toBe('"hello wod"');
    // Ctrl+A selects the whole field.
    await press('a', 'KeyA', 65, 2);
    expect(
      allText(
        unwrap(
          await browserEvaluate(ctx, {
            expression:
              "[document.getElementById('k').selectionStart, document.getElementById('k').selectionEnd]",
          }),
        ),
      ),
    ).toMatch(/0,\s*9/);
  }, 60_000);

  test('upload only accepts files inside the thread directory', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'funny-upload-'));
    writeFileSync(join(cwd, 'report.txt'), 'hello');
    const uctx = { ...ctx, cwd };
    unwrap(await browserNavigate(uctx, { url: `${base}/upload` }));
    const snap = allText(unwrap(await browserSnapshot(uctx, {})));
    const input = refOf(
      snap,
      /button "File" \[ref=(e\d+)\]|textbox "File" \[ref=(e\d+)\]|"File" \[ref=(e\d+)\]/,
    );

    const outside = await browserAct(uctx, {
      action: 'upload',
      ref: input,
      paths: ['/etc/hostname'],
    });
    expect(outside.isErr() && outside.error.code).toBe('path-not-allowed');

    unwrap(await browserAct(uctx, { action: 'upload', ref: input, paths: ['report.txt'] }));
    const name = await browserEvaluate(uctx, {
      expression: "document.getElementById('f').files[0]?.name",
    });
    expect(allText(unwrap(name))).toBe('"report.txt"');
    rmSync(cwd, { recursive: true, force: true });
  }, 60_000);

  test('appearance emulation switches the colour scheme', async () => {
    unwrap(await browserSetAppearance(ctx, { colorScheme: 'dark' }));
    const dark = await browserEvaluate(ctx, {
      expression: "matchMedia('(prefers-color-scheme: dark)').matches",
    });
    expect(allText(unwrap(dark))).toBe('true');
  }, 30_000);

  test('recording saves an MP4 into the assets directory', async () => {
    const assetsDir = mkdtempSync(join(tmpdir(), 'funny-assets-'));
    const rctx = { ...ctx, assetsDir };
    const started = await browserRecordingStart(rctx);
    if (started.isErr()) {
      // No ffmpeg with libx264 on this machine: the error is the contract.
      expect(started.error.code).toBe('recording-unavailable');
      return;
    }
    unwrap(await browserNavigate(rctx, { url: `${base}/done` }));
    unwrap(await browserNavigate(rctx, { url: `${base}/login` }));
    await new Promise((r) => setTimeout(r, 500));
    const stopped = allText(unwrap(await browserRecordingStop(rctx)));
    const path = /Recording saved: (\S+\.mp4)/.exec(stopped)?.[1];
    expect(path && existsSync(path)).toBe(true);
    rmSync(assetsDir, { recursive: true, force: true });
  }, 120_000);

  test('mouse actions tell the panel where the agent pointer goes', async () => {
    unwrap(await browserOpen(ctx, { url: `${base}/login` }));
    const snap = allText(unwrap(await browserSnapshot(ctx, {})));
    const delay = refOf(snap, /button "Delay"[^\n]*\[ref=(e\d+)\]/);
    const emitToUser = vi.mocked(wsBroker.emitToUser);
    const pointers = () =>
      emitToUser.mock.calls
        .map(([, event]) => event as unknown as { type: string; data: Record<string, unknown> })
        .filter((event) => event.type === 'browser-session:pointer')
        .map((event) => event.data);

    emitToUser.mockClear();
    unwrap(await browserAct(ctx, { action: 'click', ref: delay }));
    const [click] = pointers();
    expect(click).toMatchObject({ sessionId: `thread:${ctx.threadId}`, kind: 'click' });
    expect(click.x).toBeGreaterThan(0);
    expect(click.y).toBeGreaterThan(0);

    emitToUser.mockClear();
    unwrap(await browserAct(ctx, { action: 'hover', x: 40, y: 50 }));
    expect(pointers()).toEqual([expect.objectContaining({ x: 40, y: 50, kind: 'move' })]);
  }, 60_000);

  test('navigations tell the panel the new URL', async () => {
    unwrap(await browserOpen(ctx, { url: `${base}/login` }));
    const snap = allText(unwrap(await browserSnapshot(ctx, {})));
    const submit = refOf(snap, /button "Sign in" \[ref=(e\d+)\]/);
    const emitToUser = vi.mocked(wsBroker.emitToUser);
    emitToUser.mockClear();

    unwrap(await browserAct(ctx, { action: 'click', ref: submit }));
    const urls = emitToUser.mock.calls
      .map(([, event]) => event as unknown as { type: string; data: { url?: string } })
      .filter((event) => event.type === 'browser-session:navigated')
      .map((event) => event.data.url);
    expect(urls).toContainEqual(expect.stringContaining(`${base}/done`));
  }, 60_000);

  test('page audio starts muted and the panel turns it on and off', async () => {
    unwrap(await browserOpen(ctx, { url: `${base}/audio` }));
    const sessionId = `thread:${ctx.threadId}`;
    const session = browserSessionManager.getOwned(ctx.userId, sessionId)!;
    expect(session.audioMuted).toBe(true);
    const mutedState = () =>
      Promise.all(
        session.tab.page
          .frames()
          .map((frame) =>
            frame.evaluate(() => (document.querySelector('audio') as HTMLAudioElement).muted),
          ),
      );
    const input = (muted: boolean) =>
      browserSessionManager.dispatchInput(ctx.userId, sessionId, {
        sessionId,
        kind: 'audio',
        muted,
      });
    const emitToUser = vi.mocked(wsBroker.emitToUser);
    emitToUser.mockClear();

    await input(false);
    await input(true);
    // Muting holds every media element, in iframes too.
    expect(await mutedState()).toEqual([true, true]);
    await input(false);
    expect(await mutedState()).toEqual([false, false]);
    expect(
      emitToUser.mock.calls
        .map(([, event]) => event as unknown as { type: string; data: { muted?: boolean } })
        .filter((event) => event.type === 'browser-session:audio')
        .map((event) => event.data.muted),
    ).toEqual([false, true, false]);
    await input(true);
  }, 60_000);

  test("a background tab's popup is muted and closed with the session", async () => {
    const other = { userId: ctx.userId, threadId: 'thread-bg-popup' };
    unwrap(await browserOpen(other, { url: `${base}/login` }));
    const session = browserSessionManager.findByThread(other.userId, other.threadId)!;
    // The link popup becomes the active tab; /login goes to the background.
    const snap = allText(unwrap(await browserSnapshot(other, {})));
    unwrap(
      await browserAct(other, {
        action: 'click',
        ref: refOf(snap, /link "Open popup" \[ref=(e\d+)\]/),
      }),
    );
    await expect.poll(() => session.backgroundTabs.length).toBe(1);
    const background = session.backgroundTabs[0].page;

    await background.evaluate((url) => void window.open(url), `${base}/audio`);
    await expect.poll(() => session.backgroundTabs.length).toBe(2);
    const stray = session.backgroundTabs[1].page;
    await stray.waitForLoadState();
    await expect
      .poll(() =>
        stray.evaluate(() => {
          const el = document.querySelector('audio') as HTMLAudioElement;
          void el.play().catch(() => {});
          return el.muted;
        }),
      )
      .toBe(true);

    await browserSessionManager.close(session.sessionId, 'user');
    expect(stray.isClosed()).toBe(true);
    expect(background.isClosed()).toBe(true);
  }, 60_000);

  test('close ends the session', async () => {
    expect(allText(unwrap(await browserClose(ctx)))).toContain('closed');
    expect(browserSessionManager.findByThread(ctx.userId, ctx.threadId)).toBeNull();
  });
});
