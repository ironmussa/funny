/**
 * Runs the Phase 0 experiments against the spike Worker in local workerd
 * (wrangler's dev runtime, same wrangler.jsonc), with Hyperdrive pointed at a
 * local Postgres. Prints a JSON report. Usage: node run-spike.mjs
 */

import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { betterAuth } from 'better-auth';
import { getMigrations } from 'better-auth/db/migration';
import { username } from 'better-auth/plugins';
import pg from 'pg';
import { unstable_startWorker } from 'wrangler';

// Hyperdrive requires a password in the URL; the local trust-auth Postgres ignores it.
const PG_URL =
  process.env.PG_URL ?? `postgres://${['spike', 'spike'].join(':')}@127.0.0.1:55432/funny`;
process.env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE = PG_URL;
const RUNNER_TOKEN = 'runner-token-spike';
const AUTH_SECRET = 'spike-auth-secret-0123456789abcdef0123456789abcdef';
const persistDir = mkdtempSync(join(tmpdir(), 'funny-spike-do-'));
const report = {};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

let base = '';

async function startWorker() {
  const worker = await unstable_startWorker({
    config: 'wrangler.jsonc',
    dev: {
      server: { hostname: '127.0.0.1', port: 0 },
      inspector: false,
      persist: persistDir,
      logLevel: 'error',
    },
  });
  await worker.ready;
  base = (await worker.url).toString().replace(/\/$/, '');
  return worker;
}

/** Status of a WebSocket upgrade attempt (101, or the HTTP error status). */
function upgradeStatus(path, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${base}${path}`, {
      headers: {
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-version': '13',
        'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
        ...headers,
      },
    });
    req.on('upgrade', (_res, socket) => {
      socket.destroy();
      resolve(101);
    });
    req.on('response', (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject);
    req.end();
  });
}

async function openSocket(path, headers) {
  const ws = new WebSocket(`${base.replace('http', 'ws')}${path}`, { headers });
  ws.binaryType = 'arraybuffer';
  const messages = [];
  const waiters = [];
  ws.addEventListener('message', (e) => {
    messages.push({ at: Date.now(), data: e.data });
    waiters.splice(0).forEach((w) => w());
  });
  const closed = new Promise((resolve) =>
    ws.addEventListener('close', (e) => resolve({ code: e.code, at: Date.now() })),
  );
  const opened = await new Promise((resolve) => {
    ws.addEventListener('open', () => resolve(true));
    ws.addEventListener('error', () => resolve(false));
  });
  if (!opened) return { status: 'failed', ws: null };
  const next = async (pred = () => true, timeoutMs = 5000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const i = messages.findIndex(pred);
      if (i >= 0) return messages.splice(i, 1)[0];
      if (Date.now() > deadline) return null;
      await new Promise((r) => {
        waiters.push(r);
        setTimeout(r, 50);
      });
    }
  };
  return { status: 101, ws, next, closed };
}

const fetchWorker = (path, init) => fetch(`${base}${path}`, init);

const runnerHeaders = (runnerId, owner, token = RUNNER_TOKEN) => ({
  authorization: `Bearer ${token}`,
  'x-runner-id': runnerId,
  'x-runner-owner': owner,
});
const json = (m) => (typeof m.data === 'string' ? JSON.parse(m.data) : null);

// ── Better Auth schema in Postgres (what migrations would do at deploy) ──
console.error('[spike] migrating');
{
  const pool = new pg.Pool({ connectionString: PG_URL });
  const auth = betterAuth({
    secret: AUTH_SECRET,
    database: pool,
    emailAndPassword: { enabled: true },
    plugins: [username()],
  });
  const { runMigrations } = await getMigrations(auth.options);
  await runMigrations();
  await pool.end();
}

console.error('[spike] starting worker');
let worker = await startWorker();
console.error('[spike] worker at', base);

// E1 — runner auth at upgrade
console.error('[spike] E1 runner auth at upgrade');
{
  const wrongToken = await upgradeStatus('/runner/connect', runnerHeaders('r1', 'u1', 'wrong'));
  const rightToken = await upgradeStatus('/runner/connect', runnerHeaders('r1b', 'u1'));
  const good = await openSocket('/runner/connect', runnerHeaders('r1', 'u1'));
  const hello = json(await good.next());
  report.runnerAuth = { wrongToken, rightToken, hello };
  good.ws.close(1000, 'done');
  await good.closed;
}

// E2 — epoch survives a restart (DO storage) and replacement fences the old socket
console.error(
  '[spike] E2 epoch survives a restart (DO storage) and replacement fences the old socket',
);
{
  const first = await openSocket('/runner/connect', runnerHeaders('r2', 'u1'));
  const e1 = json(await first.next()).epoch;
  const second = await openSocket('/runner/connect', runnerHeaders('r2', 'u1'));
  const e2 = json(await second.next()).epoch;
  const firstClose = await first.closed;
  second.ws.close(1000, 'done');
  await second.closed;
  await worker.dispose();
  worker = await startWorker();
  const third = await openSocket('/runner/connect', runnerHeaders('r2', 'u1'));
  const e3 = json(await third.next()).epoch;
  third.ws.close(1000, 'done');
  await third.closed;
  report.epoch = {
    first: e1,
    replacement: e2,
    oldSocketCloseCode: firstClose.code,
    afterRestart: e3,
  };
}

// E3 — frame size limits, both directions
console.error('[spike] E3 frame size limits, both directions');
{
  const s = await openSocket('/runner/connect', runnerHeaders('r3', 'u1'));
  await s.next();
  const sizes = [64 * 1024, 1 << 20, 4 << 20, 16 << 20, 32 << 20, 33 << 20];
  const up = {};
  const down = {};
  for (const size of sizes) {
    s.ws.send(JSON.stringify({ type: 'heartbeat' }));
    try {
      s.ws.send(new Uint8Array(size));
      const ack = await s.next((m) => json(m)?.type === 'size-ack', 8000);
      up[size] = ack ? 'ok' : 'no-ack';
    } catch (error) {
      up[size] = `send-error: ${error.message}`;
    }
    if (up[size] !== 'ok') break;
  }
  const s2 = await openSocket('/runner/connect', runnerHeaders('r3b', 'u1'));
  await s2.next();
  for (const size of sizes) {
    s2.ws.send(JSON.stringify({ type: 'heartbeat' }));
    s2.ws.send(JSON.stringify({ type: 'echo-size', size }));
    const frame = await s2.next((m) => typeof m.data !== 'string', 8000);
    down[size] = frame ? `ok (${frame.data.byteLength})` : 'not received';
    if (!frame) break;
  }
  report.frameSizes = { runnerToDO: up, doToRunner: down };
  for (const x of [s, s2]) {
    try {
      x.ws.close(1000, 'done');
    } catch {}
  }
}

// E4 — heartbeat expiry via DO alarm
console.error('[spike] E4 heartbeat expiry via DO alarm');
{
  const s = await openSocket('/runner/connect', runnerHeaders('r4', 'u1'));
  await s.next();
  const silentSince = Date.now();
  // The close frame arrives as readyState CLOSING (2); the local client may not
  // finish the handshake, so poll readyState instead of waiting for 'close'.
  let closeFrameAfterMs = null;
  while (Date.now() - silentSince < 8000) {
    if (s.ws.readyState >= 2) {
      closeFrameAfterMs = Date.now() - silentSince;
      break;
    }
    await sleep(25);
  }
  const closed = await Promise.race([s.closed, sleep(500).then(() => null)]);
  const presence = await (await fetchWorker('/runner/presence/r4')).json();
  const readyStateAfter = s.ws.readyState;
  // Does a frame still reach the DO after the server-side close?
  let sendAfterClose = 'sent';
  try {
    s.ws.send(JSON.stringify({ type: 'heartbeat' }));
    const ack = await s.next((m) => json(m)?.type === 'heartbeat-ack', 1500);
    sendAfterClose = ack ? 'acked (session still alive!)' : 'no ack';
  } catch (error) {
    sendAfterClose = `throws: ${error.message}`;
  }
  report.heartbeatExpiry = {
    timeoutMs: 2000,
    closeFrameAfterMs,
    closeEventFired: Boolean(closed),
    closeCode: closed?.code ?? null,
    presenceAfter: presence,
    clientReadyStateAfter: readyStateAfter,
    sendAfterClose,
  };
}

// E5 — Better Auth in the Worker: sign-up, sign-in (password hashing), cookie session
let cookie = null;
let userId = null;
{
  // A fresh user per run, so re-runs against the same database start clean.
  const handle = `spike${Date.now().toString(36)}`;
  const body = {
    email: `${handle}@example.com`,
    password: 'Spike-password-123',
    name: 'Spike',
    username: handle,
  };
  const t0 = Date.now();
  const signUp = await fetchWorker('/api/auth/sign-up/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify(body),
  });
  const signUpMs = Date.now() - t0;
  const signInTimes = [];
  let signIn;
  for (let i = 0; i < 5; i++) {
    const t = Date.now();
    signIn = await fetchWorker('/api/auth/sign-in/username', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ username: handle, password: body.password }),
    });
    signInTimes.push(Date.now() - t);
  }
  cookie = (signIn.headers.getSetCookie?.() ?? [signIn.headers.get('set-cookie')])
    .map((c) => c.split(';')[0])
    .join('; ');
  userId = (await signIn.json()).user?.id;
  const wrong = await fetchWorker('/api/auth/sign-in/username', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ username: handle, password: 'nope-Nope-123' }),
  });
  report.betterAuth = {
    signUpStatus: signUp.status,
    signUpWallMs: signUpMs,
    signInStatus: signIn.status,
    signInWallMs: { p50: pct(signInTimes, 50), max: Math.max(...signInTimes) },
    wrongPasswordStatus: wrong.status,
    gotSessionCookie: Boolean(cookie),
  };
}

// E6 — browser socket authorized by the session cookie; fan-out latency
console.error('[spike] E6 browser socket authorized by the session cookie; fan-out latency');
{
  const anon = { status: await upgradeStatus('/browser/connect', {}) };
  const browser = await openSocket('/browser/connect', { cookie });
  const runner = await openSocket('/runner/connect', runnerHeaders('r6', userId));
  await runner.next();
  const latencies = [];
  for (let i = 0; i < 200; i++) {
    if (i % 20 === 0) runner.ws.send(JSON.stringify({ type: 'heartbeat' }));
    const sentAt = Date.now();
    runner.ws.send(JSON.stringify({ type: 'event', seq: i, sentAt }));
    const m = await browser.next((x) => json(x)?.seq === i, 3000);
    if (m) latencies.push(m.at - sentAt);
  }
  const otherUser = await openSocket('/runner/connect', runnerHeaders('r6-other', 'someone-else'));
  await otherUser.next();
  otherUser.ws.send(JSON.stringify({ type: 'event', seq: 'leak' }));
  const leaked = await browser.next((x) => json(x)?.seq === 'leak', 1000);
  report.browserFanout = {
    anonymousUpgrade: anon.status,
    authenticatedUpgrade: browser.status,
    delivered: latencies.length,
    latencyMs: { p50: pct(latencies, 50), p95: pct(latencies, 95), max: Math.max(...latencies) },
    otherUsersEventReachedThisBrowser: Boolean(leaked),
  };
  for (const x of [browser, runner, otherUser]) {
    try {
      x.ws.close(1000, 'done');
    } catch {}
  }
}

// E7 — Drizzle over Hyperdrive: per-request connection, interactive transaction
console.error(
  '[spike] E7 Drizzle over Hyperdrive: per-request connection, interactive transaction',
);
{
  const times = [];
  let last;
  for (let i = 0; i < 10; i++) {
    const t = Date.now();
    last = await (await fetchWorker('/db/tx', { method: 'POST' })).json();
    times.push(Date.now() - t);
  }
  report.drizzleHyperdrive = {
    result: last,
    wallMs: { p50: pct(times, 50), max: Math.max(...times) },
  };
}

await worker.dispose();
rmSync(persistDir, { recursive: true, force: true });
console.log(JSON.stringify(report, null, 2));
