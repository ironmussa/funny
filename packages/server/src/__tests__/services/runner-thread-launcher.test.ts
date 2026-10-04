/**
 * `startThreadOnRunner` — the single path that creates a thread on a user's
 * runner (interactive threads and automations). Runs against the real runner
 * resolution with fake transport/presence ports.
 */
import { describe, test, expect, beforeAll, beforeEach } from 'bun:test';

process.env.RUNNER_AUTH_SECRET = 'test-secret';

import {
  NONCE_HEADER,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  verifyForwardedIdentity,
} from '@funny/shared/auth/forwarded-identity';

import type { RunnerPresencePort, RunnerRequest } from '../../services/runner-ports.js';
import { startThreadOnRunner } from '../../services/runner-thread-launcher.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { seedProject, seedRunner, seedRunnerProjectAssignment } from '../helpers/test-db.js';

const RUNNER_OWNER: Record<string, string> = { 'r-alice': 'alice', 'r-bob': 'bob' };

function ports(online: string[]) {
  const sent: Array<{ runnerId: string; request: RunnerRequest }> = [];
  const presence: RunnerPresencePort = {
    isAvailable: (id) => online.includes(id),
    userHasAvailableRunner: (uid) => online.some((id) => RUNNER_OWNER[id] === uid),
    userIdForRunner: (id) => RUNNER_OWNER[id] ?? null,
    availableRunnerCount: () => online.length,
  } as RunnerPresencePort;
  const requests = {
    isAvailable: (id: string) => online.includes(id),
    request: async (runnerId: string, request: RunnerRequest) => {
      sent.push({ runnerId, request });
      return { status: 201, headers: {}, body: JSON.stringify({ id: 't-new', title: 'T' }) };
    },
  };
  return { sent, ports: { requests, presence } };
}

const input = (userId: string) => ({
  userId,
  projectId: 'p1',
  body: { projectId: 'p1', prompt: 'hi', source: 'automation' },
});

describe('startThreadOnRunner', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  beforeEach(() => {
    t.cleanup();
    seedProject(t.db as any, { id: 'p1', userId: 'alice', path: '/repo' });
    seedRunner(t.db as any, { id: 'r-alice', userId: 'alice', token: 'tok-a' });
    seedRunner(t.db as any, { id: 'r-bob', userId: 'bob', token: 'tok-b' });
    seedRunnerProjectAssignment(t.db as any, { runnerId: 'r-alice', projectId: 'p1' });
    seedRunnerProjectAssignment(t.db as any, { runnerId: 'r-bob', projectId: 'p1' });
  });

  test("dispatches to the user's own runner", async () => {
    const { sent, ports: p } = ports(['r-alice', 'r-bob']);

    const result = await startThreadOnRunner(input('bob'), p);

    expect(result._unsafeUnwrap().runnerId).toBe('r-bob');
    expect(sent.map((s) => s.runnerId)).toEqual(['r-bob']);
  });

  test("never falls back to another user's runner when the owner's is offline", async () => {
    const { sent, ports: p } = ports(['r-alice']); // bob's runner is down

    const result = await startThreadOnRunner(input('bob'), p);

    expect(result._unsafeUnwrapErr().kind).toBe('runner-unavailable');
    expect(sent).toEqual([]);
  });

  test("signs the forwarded identity for the thread's owner", async () => {
    const { sent, ports: p } = ports(['r-alice']);

    await startThreadOnRunner(input('alice'), p);

    const h = sent[0].request.headers;
    expect(h['X-Forwarded-User']).toBe('alice');
    const valid = verifyForwardedIdentity(
      { userId: 'alice', role: 'user', orgId: null, orgName: null },
      'test-secret',
      h[SIGNATURE_HEADER],
      h[TIMESTAMP_HEADER],
      h[NONCE_HEADER],
    );
    expect(valid).toBe(true);
  });

  test('surfaces a runner error with its status and message', async () => {
    const { ports: p } = ports(['r-alice']);
    p.requests.request = async () => ({
      status: 400,
      headers: {},
      body: JSON.stringify({ error: 'bad prompt' }),
    });

    const error = (await startThreadOnRunner(input('alice'), p))._unsafeUnwrapErr();

    expect(error).toEqual({ kind: 'runner-error', status: 400, message: 'bad prompt' });
  });
});
