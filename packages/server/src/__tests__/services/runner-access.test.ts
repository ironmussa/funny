/**
 * Runner-request isolation: the prover (`withRunnerFor`) against the REAL
 * resolvers, `runners` table and `runner-scope` rules, and the authorized
 * sinks' identity signing.
 */
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';

process.env.RUNNER_AUTH_SECRET = 'test-secret';

import {
  NONCE_HEADER,
  ON_BEHALF_OF_THREAD_HEADER,
  SHARE_LEVEL_HEADER,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  __resetForwardedIdentityNonceCacheForTests,
  verifyForwardedIdentity,
} from '@funny/shared/auth/forwarded-identity';

import * as auditModule from '../../lib/audit.js';
import { RunnerGrpcSessionRegistry } from '../../services/grpc/session-registry.js';
import {
  authorizedRunnerRequests,
  authorizedRunnerTerminal,
  mintOAuthCallbackState,
  runnerActor,
  withOAuthCallbackRunner,
  withRunnerFor,
  type RunnerActor,
  type RunnerTarget,
} from '../../services/runner-access/index.js';
import type { RunnerRequest } from '../../services/runner-ports.js';
import { __resetRunnerScopeCache, setProjectDedicatedRunner } from '../../services/runner-scope.js';
import { FakeRunnerRequestPort, FakeRunnerTerminalPort } from '../helpers/runner-port-fakes.js';
import {
  createTestDb,
  seedProject,
  seedRunner,
  seedRunnerProjectAssignment,
} from '../helpers/test-db.js';

let testDb: ReturnType<typeof createTestDb>;
let presence: RunnerGrpcSessionRegistry;

const alice = runnerActor({ userId: 'alice', role: 'admin', orgId: 'org-1' });
const bob = runnerActor({ userId: 'bob' });

function runner(
  id: string,
  userId: string,
  opts: { online?: boolean; role?: 'general' | 'dedicated'; project?: string } = {},
) {
  const online = opts.online ?? true;
  seedRunner(testDb.db, {
    id,
    userId,
    token: `tok-${id}`,
    hostname: id,
    httpUrl: null,
    role: opts.role ?? 'general',
    status: online ? 'online' : 'offline',
  });
  if (opts.project) {
    seedRunnerProjectAssignment(testDb.db, { runnerId: id, projectId: opts.project });
  }
  if (online) presence.activate(id, { invalidate: () => {} }, userId);
}

/** Runs the callback and reports which runner (if any) was certified. */
async function certified(actor: RunnerActor, target: RunnerTarget) {
  const result = await withRunnerFor(actor, target, presence, async (a, r, proof) => ({
    actor: a.value.userId,
    runner: r.value as string,
    kind: proof.kind,
  }));
  return result.isOk() ? result.value : result.error;
}

beforeEach(async () => {
  presence = new RunnerGrpcSessionRegistry({ heartbeatTimeoutMs: 10_000 });
  __resetRunnerScopeCache();
  __resetForwardedIdentityNonceCacheForTests();
  testDb = createTestDb();
  const { setConnection } = await import('../../db/index.js');
  setConnection({
    db: testDb.db as any,
    schema: testDb.schema,
    sqlite: testDb.sqlite,
    mode: 'sqlite',
    close: async () => testDb.sqlite.close(),
  });
  seedProject(testDb.db, { id: 'p-shared', userId: 'alice', path: '/srv/shared' });
  seedProject(testDb.db, { id: 'p-other', userId: 'alice', path: '/srv/other' });
});

afterEach(() => {
  mock.restore();
});

describe('withRunnerFor — certification against real resolution', () => {
  test("the actor's own runner is certified for a project", async () => {
    runner('r-alice', 'alice', { project: 'p-shared' });
    runner('r-bob', 'bob', { project: 'p-shared' });
    expect(await certified(alice, { kind: 'project', projectId: 'p-shared' })).toEqual({
      actor: 'alice',
      runner: 'r-alice',
      kind: 'RunnerFor',
    });
    expect(await certified(bob, { kind: 'project-checkout', projectId: 'p-shared' })).toMatchObject(
      { actor: 'bob', runner: 'r-bob' },
    );
  });

  test("another user's online runner is never certified, and no callback runs", async () => {
    runner('r-bob', 'bob', { project: 'p-shared' });
    let ran = 0;
    const result = await withRunnerFor(
      alice,
      { kind: 'project', projectId: 'p-shared' },
      presence,
      async () => {
        ran += 1;
      },
    );
    expect(result.isErr()).toBe(true);
    expect(ran).toBe(0);
    expect(await certified(alice, { kind: 'projectless' })).toMatchObject({
      reason: 'general-runner-offline',
    });
  });

  test('a runner chosen elsewhere is refused and audited when it belongs to someone else', async () => {
    runner('r-bob', 'bob');
    const audit = spyOn(auditModule, 'audit').mockImplementation(() => {});
    const result = await certified(alice, { kind: 'runner', runnerId: 'r-bob', projectId: null });
    expect(result).toMatchObject({ kind: 'runner-unavailable', reason: 'general-runner-offline' });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'authz.cross_tenant_refused', actorId: 'alice' }),
    );
  });

  test('a dedicated runner is refused for an unrelated project and for projectless work', async () => {
    runner('r-ded', 'alice', { role: 'dedicated', project: 'p-shared' });
    runner('r-gen', 'alice');
    expect((await setProjectDedicatedRunner('p-shared', 'alice', 'r-ded')).ok).toBe(true);
    const audit = spyOn(auditModule, 'audit').mockImplementation(() => {});

    expect(
      await certified(alice, { kind: 'runner', runnerId: 'r-ded', projectId: 'p-other' }),
    ).toMatchObject({ kind: 'runner-unavailable' });
    expect(
      await certified(alice, { kind: 'runner', runnerId: 'r-ded', projectId: null }),
    ).toMatchObject({ kind: 'runner-unavailable' });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'runner.scope_denied' }));
    // The same runner IS certified for its own project.
    expect(
      await certified(alice, { kind: 'runner', runnerId: 'r-ded', projectId: 'p-shared' }),
    ).toMatchObject({ runner: 'r-ded' });
  });

  test('projectless work goes to a general runner only', async () => {
    runner('r-ded', 'alice', { role: 'dedicated', project: 'p-shared' });
    await setProjectDedicatedRunner('p-shared', 'alice', 'r-ded');
    expect(await certified(alice, { kind: 'projectless' })).toMatchObject({
      reason: 'general-runner-offline',
    });
    runner('r-gen', 'alice');
    expect(await certified(alice, { kind: 'projectless' })).toMatchObject({ runner: 'r-gen' });
  });

  test('a pinned project whose dedicated runner is offline reports project-runner-offline, no fallback', async () => {
    runner('r-ded', 'alice', { role: 'dedicated', project: 'p-shared', online: false });
    runner('r-gen', 'alice', { project: 'p-shared' });
    await setProjectDedicatedRunner('p-shared', 'alice', 'r-ded');
    expect(await certified(alice, { kind: 'project', projectId: 'p-shared' })).toEqual({
      kind: 'runner-unavailable',
      reason: 'project-runner-offline',
      projectId: 'p-shared',
    });
    expect(await certified(alice, { kind: 'project-checkout', projectId: 'p-shared' })).toEqual({
      kind: 'runner-unavailable',
      reason: 'project-runner-offline',
      projectId: 'p-shared',
    });
    expect(
      await certified(alice, {
        kind: 'request',
        path: '/api/projects/p-shared/branches',
        query: {},
      }),
    ).toMatchObject({ reason: 'project-runner-offline' });
  });

  test('owned-runner certifies ownership only (cleanup on a runner that lost project access)', async () => {
    runner('r-gen', 'alice', { project: 'p-shared' });
    runner('r-ded', 'alice', { role: 'dedicated', project: 'p-shared' });
    await setProjectDedicatedRunner('p-shared', 'alice', 'r-ded');
    expect(
      await certified(alice, { kind: 'runner', runnerId: 'r-gen', projectId: 'p-shared' }),
    ).toMatchObject({ kind: 'runner-unavailable' });
    expect(await certified(alice, { kind: 'owned-runner', runnerId: 'r-gen' })).toMatchObject({
      runner: 'r-gen',
    });
    expect(await certified(bob, { kind: 'owned-runner', runnerId: 'r-gen' })).toMatchObject({
      kind: 'runner-unavailable',
    });
  });

  test('request targets follow the route and stay scoped to the actor', async () => {
    runner('r-alice', 'alice', { project: 'p-shared' });
    runner('r-bob', 'bob', { project: 'p-shared' });
    expect(
      await certified(alice, {
        kind: 'request',
        path: '/api/projects/p-shared/branches',
        query: {},
      }),
    ).toMatchObject({ runner: 'r-alice' });
    expect(await certified(bob, { kind: 'request', path: '/api/browse', query: {} })).toMatchObject(
      { runner: 'r-bob' },
    );
  });

  test('ownership falls back to the runners table when presence does not know the runner', async () => {
    runner('r-alice', 'alice', { online: false });
    expect(await certified(alice, { kind: 'owned-runner', runnerId: 'r-alice' })).toMatchObject({
      runner: 'r-alice',
    });
  });
});

/** Mint a callback state exactly as the proxy does: bound to a certified (actor, runner). */
async function boundState(actor: RunnerActor, runnerId: string, now?: number): Promise<string> {
  const minted = await withRunnerFor(
    actor,
    { kind: 'owned-runner', runnerId },
    presence,
    async (a, r, proof) => mintOAuthCallbackState(a, r, proof, now),
  );
  return minted._unsafeUnwrap();
}

/** Which runner (if any) the callback prover certified for `state`. */
async function oauthRoute(state: string | undefined) {
  let ran = 0;
  const result = await withOAuthCallbackRunner(state, presence, async (r, proof) => {
    ran += 1;
    return { runner: r.value as string, kind: proof.kind };
  });
  return { result: result.isOk() ? result.value : result.error, ran };
}

describe('withOAuthCallbackRunner — routed only by the server-signed state (H3/M3)', () => {
  test("a state bound to alice's runner reaches that runner, never another tenant's", async () => {
    runner('r-bob', 'bob');
    runner('r-alice', 'alice');
    const state = await boundState(alice, 'r-alice');
    expect(await oauthRoute(state)).toEqual({
      result: { runner: 'r-alice', kind: 'OAuthCallbackRunner' },
      ran: 1,
    });
    // And bob's state reaches bob's runner only.
    expect((await oauthRoute(await boundState(bob, 'r-bob'))).result).toMatchObject({
      runner: 'r-bob',
    });
  });

  test('a missing, unsigned, forged or tampered state reaches no runner', async () => {
    runner('r-bob', 'bob');
    runner('r-alice', 'alice');
    const valid = await boundState(alice, 'r-alice');
    const [v, , sig] = valid.split('.');
    const retargeted = Buffer.from(
      JSON.stringify({ u: 'bob', r: 'r-bob', e: Date.now() + 60_000, n: 'x' }),
    ).toString('base64url');
    for (const state of [
      undefined,
      '',
      'deadbeefdeadbeefdeadbeefdeadbeef',
      `${v}.${retargeted}.${sig}`,
      `${valid}x`,
    ]) {
      expect(await oauthRoute(state)).toEqual({ result: { kind: 'oauth-state-invalid' }, ran: 0 });
    }
  });

  test('an expired state is refused', async () => {
    runner('r-alice', 'alice');
    const state = await boundState(alice, 'r-alice', Date.now() - 11 * 60 * 1000);
    expect(await oauthRoute(state)).toEqual({ result: { kind: 'oauth-state-invalid' }, ran: 0 });
  });

  test('no fallback: an offline bound runner fails even with other runners online', async () => {
    runner('r-alice', 'alice');
    const state = await boundState(alice, 'r-alice');
    presence = new RunnerGrpcSessionRegistry({ heartbeatTimeoutMs: 10_000 });
    runner('r-alice-2', 'alice');
    runner('r-bob', 'bob');
    expect(await oauthRoute(state)).toEqual({
      result: { kind: 'runner-unavailable', reason: 'general-runner-offline' },
      ran: 0,
    });
  });

  test('a bound runner that changed owner is refused and audited', async () => {
    runner('r-x', 'alice');
    const state = await boundState(alice, 'r-x');
    presence.activate('r-x', { invalidate: () => {} }, 'bob');
    const audit = spyOn(auditModule, 'audit').mockImplementation(() => {});
    expect(await oauthRoute(state)).toMatchObject({
      result: { kind: 'runner-unavailable' },
      ran: 0,
    });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'authz.cross_tenant_refused', actorId: 'alice' }),
    );
  });
});

describe('AuthorizedRunnerRequests — identity signing', () => {
  function captured(port: FakeRunnerRequestPort): RunnerRequest {
    return port.requests.at(-1)!.request;
  }

  test('signs the named actor and the request verifies for exactly that identity', async () => {
    runner('r-alice', 'alice');
    const port = new FakeRunnerRequestPort();
    port.available.add('r-alice');
    await withRunnerFor(alice, { kind: 'projectless' }, presence, (a, r, proof) =>
      authorizedRunnerRequests(port).send(a, r, proof, {
        method: 'POST',
        path: '/api/x',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }),
    );
    const { headers, path, method } = captured(port);
    expect([method, path]).toEqual(['POST', '/api/x']);
    expect(headers['X-Forwarded-User']).toBe('alice');
    expect(headers['X-Forwarded-Role']).toBe('admin');
    expect(headers['X-Forwarded-Org']).toBe('org-1');
    expect(headers['X-Runner-Auth']).toBe('test-secret');
    expect(headers['content-type']).toBe('application/json');
    const verify = (userId: string) =>
      verifyForwardedIdentity(
        { userId, role: 'admin', orgId: 'org-1', orgName: null },
        'test-secret',
        headers[SIGNATURE_HEADER],
        headers[TIMESTAMP_HEADER],
        headers[NONCE_HEADER],
      );
    expect(verify('bob')).toBe(false);
    expect(verify('alice')).toBe(true);
  });

  test('drops spoofed identity headers supplied by the caller', async () => {
    runner('r-alice', 'alice');
    const port = new FakeRunnerRequestPort();
    port.available.add('r-alice');
    await withRunnerFor(alice, { kind: 'projectless' }, presence, (a, r, proof) =>
      authorizedRunnerRequests(port).send(a, r, proof, {
        method: 'GET',
        path: '/api/x',
        headers: {
          'x-forwarded-user': 'mallory',
          'X-Forwarded-Role': 'owner',
          'x-runner-auth': 'wrong',
          [SHARE_LEVEL_HEADER]: 'steer',
          [ON_BEHALF_OF_THREAD_HEADER]: 't-victim',
          [SIGNATURE_HEADER.toLowerCase()]: 'deadbeef',
          range: 'bytes=0-1',
        },
      }),
    );
    const { headers } = captured(port);
    expect(headers['X-Forwarded-User']).toBe('alice');
    expect(headers['X-Forwarded-Role']).toBe('admin');
    expect(headers['X-Runner-Auth']).toBe('test-secret');
    expect(headers['x-forwarded-user']).toBeUndefined();
    expect(headers['x-runner-auth']).toBeUndefined();
    expect(headers[SHARE_LEVEL_HEADER]).toBeUndefined();
    expect(headers[ON_BEHALF_OF_THREAD_HEADER]).toBeUndefined();
    expect(headers[SIGNATURE_HEADER.toLowerCase()]).toBeUndefined();
    expect(headers.range).toBe('bytes=0-1');
  });

  test('every send carries a fresh nonce', async () => {
    runner('r-alice', 'alice');
    const port = new FakeRunnerRequestPort();
    port.available.add('r-alice');
    await withRunnerFor(alice, { kind: 'projectless' }, presence, async (a, r, proof) => {
      const sink = authorizedRunnerRequests(port);
      await Promise.all(
        Array.from({ length: 5 }, () => sink.send(a, r, proof, { method: 'GET', path: '/api/x' })),
      );
    });
    expect(new Set(port.requests.map(({ request }) => request.headers[NONCE_HEADER])).size).toBe(5);
  });

  test('delegated sends sign the sharee with a steer claim while targeting the owner runner', async () => {
    runner('r-alice', 'alice');
    const port = new FakeRunnerRequestPort();
    port.available.add('r-alice');
    const sharee = runnerActor({ userId: 'cleo', role: 'user', orgId: 'org-1' });
    await withRunnerFor(
      alice,
      { kind: 'request', path: '/api/threads/t1/message', query: {} },
      presence,
      (owner, r, proof) =>
        authorizedRunnerRequests(port).sendDelegated(
          owner,
          r,
          proof,
          { sharee, threadId: 't1' },
          { method: 'POST', path: '/api/threads/t1/message', body: '{}' },
        ),
    );
    const { headers } = captured(port);
    expect(port.requests[0]!.runnerId).toBe('r-alice');
    expect(headers['X-Forwarded-User']).toBe('cleo');
    expect(headers[SHARE_LEVEL_HEADER]).toBe('steer');
    expect(headers[ON_BEHALF_OF_THREAD_HEADER]).toBe('t1');
    expect(
      verifyForwardedIdentity(
        {
          userId: 'cleo',
          role: 'user',
          orgId: 'org-1',
          orgName: null,
          shareLevel: 'steer',
          onBehalfOfThread: 't1',
        },
        'test-secret',
        headers[SIGNATURE_HEADER],
        headers[TIMESTAMP_HEADER],
        headers[NONCE_HEADER],
      ),
    ).toBe(true);
  });

  test('the OAuth callback variant sends the shared secret and no identity', async () => {
    runner('r-gen', 'bob');
    const port = new FakeRunnerRequestPort();
    port.available.add('r-gen');
    const state = await boundState(bob, 'r-gen');
    await withOAuthCallbackRunner(state, presence, (r, proof) =>
      authorizedRunnerRequests(port).sendOAuthCallback(r, proof, {
        method: 'GET',
        path: '/api/mcp/oauth/callback?code=1',
        headers: { 'X-Forwarded-User': 'mallory', 'X-Forwarded-Host': 'app.test' },
      }),
    );
    const { headers } = captured(port);
    expect(headers['X-Runner-Auth']).toBe('test-secret');
    expect(headers['X-Forwarded-Host']).toBe('app.test');
    expect(headers['X-Forwarded-User']).toBeUndefined();
    expect(headers[SIGNATURE_HEADER]).toBeUndefined();
    expect(headers[NONCE_HEADER]).toBeUndefined();
  });

  test('a missing transport fails at send time, after certification', async () => {
    runner('r-alice', 'alice');
    await expect(
      withRunnerFor(alice, { kind: 'projectless' }, presence, (a, r, proof) =>
        authorizedRunnerRequests(undefined).send(a, r, proof, { method: 'GET', path: '/api/x' }),
      ),
    ).rejects.toThrow('transport');
  });
});

describe('AuthorizedRunnerTerminal', () => {
  test('dispatches and lists with the certified actor id', async () => {
    runner('r-alice', 'alice');
    const port = new FakeRunnerTerminalPort();
    port.available.add('r-alice');
    port.sessions.set('r-alice\0alice', [{ ptyId: 'p1', cwd: '/x' }]);
    const listed = await withRunnerFor(
      alice,
      { kind: 'projectless' },
      presence,
      async (a, r, proof) => {
        const terminal = authorizedRunnerTerminal(port);
        expect(terminal.isAvailable(r)).toBe(true);
        terminal.dispatch(a, r, proof, { type: 'pty:write', data: { id: 'p1', data: 'ls\n' } });
        return terminal.listSessions(a, r, proof);
      },
    );
    expect(port.events).toEqual([
      {
        runnerId: 'r-alice',
        userId: 'alice',
        event: { type: 'pty:write', data: { id: 'p1', data: 'ls\n' } },
      },
    ]);
    expect(listed._unsafeUnwrap()).toEqual([{ ptyId: 'p1', cwd: '/x' }]);
  });
});
