/**
 * Phase 0 spike Worker (docs/plans/cloudflare-portability.md).
 *
 * Throwaway. It answers the go/no-go questions with the smallest stand-ins
 * for the real pieces:
 *   - RunnerSessionDO: one per runner. Terminates the runner's outbound
 *     WebSocket (hibernation API), keeps a monotonic epoch in DO storage,
 *     expires the session with an alarm when heartbeats stop, and forwards
 *     runner events to the owner's UserHubDO.
 *   - UserHubDO: one per user. Holds that user's browser sockets and fans
 *     events out to them.
 *   - The Worker authenticates the runner (Bearer at upgrade) and the browser
 *     (Better Auth session cookie at upgrade) BEFORE handing the socket to a
 *     DO, and serves Better Auth and a Drizzle-over-Hyperdrive transaction probe.
 */

import { betterAuth } from 'better-auth';
import { username } from 'better-auth/plugins';
import { DurableObject } from 'cloudflare:workers';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Hono } from 'hono';
import pg from 'pg';

const HEARTBEAT_TIMEOUT_MS = 2_000;

// ── Per-request database (Hyperdrive) ────────────────────────────

function withClient(env, work) {
  const client = new pg.Client({ connectionString: env.HYPERDRIVE.connectionString });
  return (async () => {
    await client.connect();
    try {
      return await work(client);
    } finally {
      await client.end();
    }
  })();
}

function authFor(env, pool, origin) {
  return betterAuth({
    secret: env.AUTH_SECRET,
    baseURL: origin,
    database: pool,
    emailAndPassword: { enabled: true },
    plugins: [username()],
    session: { cookieCache: { enabled: true, maxAge: 300 } },
  });
}

async function withAuth(env, request, work) {
  const pool = new pg.Pool({ connectionString: env.HYPERDRIVE.connectionString, max: 2 });
  try {
    return await work(authFor(env, pool, new URL(request.url).origin));
  } finally {
    await pool.end();
  }
}

// ── Worker ───────────────────────────────────────────────────────

const app = new Hono();

app.on(['GET', 'POST'], '/api/auth/*', (c) =>
  withAuth(c.env, c.req.raw, (auth) => auth.handler(c.req.raw)),
);

// Runner: Bearer at upgrade, then the socket goes to the runner's DO.
app.get('/runner/connect', async (c) => {
  if (c.req.header('authorization') !== `Bearer ${c.env.RUNNER_TOKEN}`) {
    return c.text('unauthorized', 401);
  }
  const runnerId = c.req.header('x-runner-id');
  const userId = c.req.header('x-runner-owner');
  if (!runnerId || !userId) return c.text('missing runner identity', 400);
  const stub = c.env.RUNNER.get(c.env.RUNNER.idFromName(runnerId));
  const headers = new Headers(c.req.raw.headers);
  headers.set('x-owner', userId);
  headers.set('x-runner-id', runnerId);
  return stub.fetch(new Request(c.req.raw, { headers }));
});

app.get('/runner/presence/:id', async (c) => {
  const stub = c.env.RUNNER.get(c.env.RUNNER.idFromName(c.req.param('id')));
  return c.json(await stub.presence());
});

// Browser: Better Auth session cookie at upgrade, then the user's hub.
app.get('/browser/connect', async (c) => {
  const session = await withAuth(c.env, c.req.raw, (auth) =>
    auth.api.getSession({ headers: c.req.raw.headers }),
  );
  if (!session) return c.text('unauthorized', 401);
  const stub = c.env.USERHUB.get(c.env.USERHUB.idFromName(session.user.id));
  return stub.fetch(c.req.raw);
});

// Interactive transaction over a per-request connection.
app.post('/db/tx', (c) =>
  withClient(c.env, async (client) => {
    const db = drizzle(client);
    await db.execute(sql`CREATE TABLE IF NOT EXISTS spike_rows (id text PRIMARY KEY, n int)`);
    const id = crypto.randomUUID();
    let seenInside = null;
    let rolledBack = false;
    try {
      await db.transaction(async (tx) => {
        await tx.execute(sql`INSERT INTO spike_rows (id, n) VALUES (${id}, 1)`);
        seenInside = (await tx.execute(sql`SELECT n FROM spike_rows WHERE id = ${id}`)).rows.length;
        tx.rollback();
      });
    } catch (error) {
      rolledBack = /rollback/i.test(error?.message ?? '');
      if (!rolledBack) throw error;
    }
    const after = await db.execute(sql`SELECT n FROM spike_rows WHERE id = ${id}`);
    return c.json({ seenInside, rolledBack, visibleAfterRollback: after.rows.length });
  }),
);

export default app;

// ── RunnerSessionDO ──────────────────────────────────────────────

export class RunnerSessionDO extends DurableObject {
  async fetch(request) {
    if (request.headers.get('upgrade') !== 'websocket')
      return new Response('expected websocket', { status: 426 });
    const epoch = ((await this.ctx.storage.get('epoch')) ?? 0) + 1;
    const owner = request.headers.get('x-owner');
    const runnerId = request.headers.get('x-runner-id');
    // Replacing a session invalidates the previous one (epoch fencing).
    for (const old of this.ctx.getWebSockets()) old.close(4001, 'replaced');
    await this.ctx.storage.put({ epoch, owner, runnerId, online: true, lastHeartbeat: Date.now() });
    await this.ctx.storage.setAlarm(Date.now() + HEARTBEAT_TIMEOUT_MS);

    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server, [`epoch:${epoch}`]);
    server.send(
      JSON.stringify({ type: 'hello', epoch, hasBufferedAmount: 'bufferedAmount' in server }),
    );
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    const size = typeof message === 'string' ? message.length : message.byteLength;
    if (typeof message !== 'string') {
      ws.send(JSON.stringify({ type: 'size-ack', size }));
      return;
    }
    const msg = JSON.parse(message);
    if (msg.type === 'heartbeat') {
      await this.ctx.storage.put('lastHeartbeat', Date.now());
      await this.ctx.storage.setAlarm(Date.now() + HEARTBEAT_TIMEOUT_MS);
      ws.send(JSON.stringify({ type: 'heartbeat-ack' }));
    } else if (msg.type === 'event') {
      const owner = await this.ctx.storage.get('owner');
      const hub = this.env.USERHUB.get(this.env.USERHUB.idFromName(owner));
      await hub.publish({ ...msg, runnerDoAt: Date.now() });
    } else if (msg.type === 'echo-size') {
      // Server → runner: a frame of the requested size.
      ws.send(new Uint8Array(msg.size));
    }
  }

  async webSocketClose(ws, code) {
    if (this.ctx.getWebSockets().length <= 1) await this.ctx.storage.put('online', false);
    ws.close(code, 'closing');
  }

  async alarm() {
    const lastHeartbeat = (await this.ctx.storage.get('lastHeartbeat')) ?? 0;
    if (Date.now() - lastHeartbeat >= HEARTBEAT_TIMEOUT_MS) {
      for (const ws of this.ctx.getWebSockets()) ws.close(4000, 'heartbeat timeout');
      await this.ctx.storage.put('online', false);
    } else {
      await this.ctx.storage.setAlarm(lastHeartbeat + HEARTBEAT_TIMEOUT_MS);
    }
  }

  async presence() {
    const [epoch, online, sockets] = await Promise.all([
      this.ctx.storage.get('epoch'),
      this.ctx.storage.get('online'),
      Promise.resolve(this.ctx.getWebSockets().length),
    ]);
    return { epoch: epoch ?? 0, online: online ?? false, sockets };
  }
}

// ── UserHubDO ────────────────────────────────────────────────────

export class UserHubDO extends DurableObject {
  async fetch() {
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async publish(event) {
    const payload = JSON.stringify({ ...event, hubAt: Date.now() });
    const sockets = this.ctx.getWebSockets();
    for (const ws of sockets) ws.send(payload);
    return sockets.length;
  }

  async webSocketMessage() {}

  async webSocketClose(ws, code) {
    ws.close(code, 'closing');
  }
}
