/**
 * runner-provision-tokens.ts + registerSandboxRunner (thread-sandboxes):
 * single-use, short-lived, thread-bound enrollment for sandbox runners.
 */
import { describe, test, expect, beforeEach } from 'bun:test';

import { runners } from '../../db/schema.js';
import { registerSandboxRunner } from '../../services/runner-manager.js';
import {
  consumeProvisionToken,
  issueThreadProvisionToken,
} from '../../services/runner-provision-tokens.js';
import {
  __resetRunnerScopeCache,
  sandboxRunnerIdForThread,
  sandboxThreadOfRunner,
} from '../../services/runner-scope.js';
import { createTestDb, seedProject, seedRunner, seedThread } from '../helpers/test-db.js';

let testDb: ReturnType<typeof createTestDb>;

beforeEach(async () => {
  testDb = createTestDb();
  const { setConnection } = await import('../../db/index.js');
  setConnection({
    db: testDb.db as any,
    schema: testDb.schema,
    sqlite: testDb.sqlite,
    mode: 'sqlite',
    close: async () => testDb.sqlite.close(),
  });
  __resetRunnerScopeCache();
  seedProject(testDb.db, { id: 'px', userId: 'alice', path: '/home/alice/x' });
  seedThread(testDb.db, { id: 't-box', projectId: 'px', userId: 'alice' });
});

async function issue(overrides: { userId?: string; ttlMs?: number; now?: Date } = {}) {
  const result = await issueThreadProvisionToken({
    userId: overrides.userId ?? 'alice',
    threadId: 't-box',
    ttlMs: overrides.ttlMs,
    now: overrides.now,
  });
  if (result.isErr()) throw new Error(`issue failed: ${result.error.kind}`);
  return result.value.token;
}

const kindOf = async (token: string, now?: Date) => {
  const result = await consumeProvisionToken(token, now);
  return result.isErr() ? result.error.kind : 'ok';
};

describe('provisioning tokens', () => {
  test('a token grants its user, project and thread exactly once', async () => {
    const token = await issue();
    const grant = await consumeProvisionToken(token);
    expect(grant.isOk() && grant.value).toMatchObject({
      userId: 'alice',
      projectId: 'px',
      threadId: 't-box',
    });
    expect(await kindOf(token)).toBe('used');
  });

  test('only a hash is stored', async () => {
    const token = await issue();
    const raw = testDb.sqlite.query('SELECT token_hash FROM runner_provision_tokens').get() as {
      token_hash: string;
    };
    expect(raw.token_hash).not.toContain(token);
    expect(raw.token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test('expired, unknown and malformed tokens are refused', async () => {
    const issuedAt = new Date('2026-01-01T00:00:00Z');
    const token = await issue({ ttlMs: 60_000, now: issuedAt });
    expect(await kindOf(token, new Date('2026-01-01T00:01:01Z'))).toBe('expired');
    expect(await kindOf('rprov_unknown')).toBe('invalid');
    expect(await kindOf('utkn_not-a-provision-token')).toBe('invalid');
  });

  test('a token cannot be minted for another user’s thread', async () => {
    const result = await issueThreadProvisionToken({ userId: 'mallory', threadId: 't-box' });
    expect(result.isErr() && result.error.kind).toBe('thread-mismatch');
  });

  test('a token for a deleted thread is refused', async () => {
    const token = await issue();
    testDb.sqlite.run("DELETE FROM threads WHERE id = 't-box'");
    expect(await kindOf(token)).toBe('thread-mismatch');
  });
});

describe('registerSandboxRunner', () => {
  const advertisement = {
    name: 'box-funny',
    hostname: 'shared-host',
    os: 'linux',
    providers: undefined,
    activeBuiltins: [],
    availableProviders: [],
  } as any;

  test('creates a new sandbox runner bound to the thread, never reusing a hostname', async () => {
    seedRunner(testDb.db, {
      id: 'r-general',
      userId: 'alice',
      hostname: 'shared-host',
      token: 'tok-general',
      role: 'general',
    });

    const result = await registerSandboxRunner(advertisement, 'alice', 't-box');

    expect(result.runnerId).not.toBe('r-general');
    expect(await sandboxThreadOfRunner(result.runnerId)).toBe('t-box');
    expect(await sandboxRunnerIdForThread('t-box')).toBe(result.runnerId);
    const general = testDb.db
      .select()
      .from(runners)
      .all()
      .find((r) => r.id === 'r-general');
    expect(general?.role).toBe('general');
    expect(general?.threadId ?? null).toBeNull();
  });
});
