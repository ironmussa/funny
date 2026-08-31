import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  createAuthSessionStore,
  createThreadNavigationStore,
  createThreadWorkspaceStore,
} from '@funny/client-core';

import { createNativeClientComposition } from '../platform/composition';
import { NativeAuthService } from '../services/auth';
import { nativeJsonRequest } from '../services/native-api';
import { NativeRealtimeService } from '../services/realtime';
import { createNativeRealtimeActions } from '../services/realtime-actions';

const ADMIN_PASSWORD = 'Funny-Integration-Password-2026!';
const SERVER_ENTRY = resolve(import.meta.dir, '../../../server/src/index.ts');
const directories: string[] = [];
const processes: Bun.Subprocess[] = [];

afterEach(async () => {
  for (const child of processes.splice(0)) await stopServer(child);
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function reservePort(): number {
  const reservation = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => new Response('reserved'),
  });
  const port = reservation.port;
  reservation.stop(true);
  return port;
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(40);
  }
  throw new Error(`Condition was not met within ${timeoutMs}ms`);
}

async function startServer(options: {
  port: number;
  dataDirectory: string;
}): Promise<Bun.Subprocess> {
  const origin = `http://127.0.0.1:${options.port}`;
  const child = Bun.spawn({
    cmd: [process.execPath, SERVER_ENTRY],
    cwd: resolve(import.meta.dir, '../../../..'),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: String(options.port),
      FUNNY_DATA_DIR: options.dataDirectory,
      RUNNER_AUTH_SECRET: 'runner-integration-secret-that-is-long-and-unique',
      BETTER_AUTH_SECRET: 'better-auth-integration-secret-that-is-long-and-unique',
      BETTER_AUTH_BASE_URL: origin,
      BETTER_AUTH_COOKIE_SECURE: 'false',
      ADMIN_USERNAME: 'admin',
      ADMIN_PASSWORD,
      CORS_ORIGIN: 'http://localhost:5173',
      DATABASE_URL: '',
    },
    stdout: 'ignore',
    stderr: 'ignore',
  });
  processes.push(child);
  await waitFor(async () => {
    if (child.exitCode !== null) throw new Error(`Funny server exited with ${child.exitCode}`);
    try {
      return (await fetch(`${origin}/api/health`)).ok;
    } catch {
      return false;
    }
  });
  return child;
}

async function stopServer(child: Bun.Subprocess): Promise<void> {
  const index = processes.indexOf(child);
  if (index >= 0) processes.splice(index, 1);
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([child.exited, Bun.sleep(5_000)]);
  if (child.exitCode === null) {
    child.kill('SIGKILL');
    await child.exited;
  }
}

function createAuth(dataDirectory: string, port: number) {
  const composition = createNativeClientComposition({
    dataDirectory,
    serverOrigin: `http://127.0.0.1:${port}`,
    localServerPort: port,
    clientOrigin: 'http://localhost:5173',
    diagnosticSink: () => undefined,
  });
  const state = createAuthSessionStore();
  const auth = new NativeAuthService({
    platform: composition.platform,
    cookies: composition.cookies,
    state,
    clientOrigin: composition.clientOrigin,
  });
  return { auth, composition, state };
}

describe('native client with a local Funny server', () => {
  test('signs in, restores the session, uses authenticated REST and realtime, and rejects expiry', async () => {
    const root = mkdtempSync(join(tmpdir(), 'funny-gpuix-server-integration-'));
    directories.push(root);
    const serverData = join(root, 'server');
    const clientData = join(root, 'client');
    const port = reservePort();
    let server = await startServer({ port, dataDirectory: serverData });

    const first = createAuth(clientData, port);
    const signedIn = await first.auth.signIn('admin', ADMIN_PASSWORD);
    expect(signedIn.user).toMatchObject({ username: 'admin', role: 'admin' });
    expect(first.state.getState().phase).toBe('authenticated');
    expect(first.composition.cookies.header()).toBeString();

    const restored = createAuth(clientData, port);
    expect((await restored.auth.restore())?.user.id).toBe(signedIn.user.id);
    expect(restored.state.getState().phase).toBe('authenticated');

    const projects = await nativeJsonRequest<unknown[]>({
      platform: restored.composition.platform,
      path: '/projects',
      clientOrigin: restored.composition.clientOrigin,
    });
    expect(projects).toBeArray();

    const navigation = createThreadNavigationStore();
    const workspace = createThreadWorkspaceStore();
    const realtime = new NativeRealtimeService({
      platform: restored.composition.platform,
      cookies: restored.composition.cookies,
      actions: createNativeRealtimeActions({
        navigation,
        workspace,
        diagnostics: restored.composition.platform.diagnostics,
      }),
      effects: { emit: () => undefined },
      clientOrigin: restored.composition.clientOrigin,
      refreshForFocus: () => undefined,
      refreshForReconnect: () => undefined,
      onSessionRejected: () => restored.auth.rejectSession(),
    });
    expect(realtime.connect()).toBe(true);
    await waitFor(() => realtime.current().phase === 'connected');
    expect(realtime.current()).toEqual({ phase: 'connected', error: null });
    realtime.disconnect();

    const cachedCookieHeader = restored.composition.cookies.header();
    expect(cachedCookieHeader).toBeString();
    const uncachedCookieHeader = cachedCookieHeader!
      .split('; ')
      .filter((cookie) => !cookie.startsWith('better-auth.session_data='))
      .join('; ');
    expect(uncachedCookieHeader).not.toBe(cachedCookieHeader);

    await stopServer(server);
    const database = new Database(join(serverData, 'data.db'));
    database.run("UPDATE session SET expires_at = '1970-01-01T00:00:00.000Z'");
    database.close();
    writeFileSync(
      join(clientData, 'session.json'),
      `${JSON.stringify({ cookieHeader: uncachedCookieHeader })}\n`,
      { mode: 0o600 },
    );
    server = await startServer({ port, dataDirectory: serverData });

    const expired = createAuth(clientData, port);
    expect(await expired.auth.restore()).toBeNull();
    expect(expired.state.getState().phase).toBe('anonymous');
    expect(expired.composition.cookies.header()).toBeNull();

    expired.composition.transport.dispose();
    restored.composition.transport.dispose();
    first.composition.transport.dispose();
    await stopServer(server);
  }, 30_000);
});
