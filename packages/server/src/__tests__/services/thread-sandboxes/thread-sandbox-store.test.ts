import { beforeEach, describe, expect, test } from 'bun:test';

import { resolvePublicServerUrl } from '../../../services/thread-sandboxes/public-server-url.js';
import {
  sqlThreadSandboxStore,
  type ThreadSandboxRow,
} from '../../../services/thread-sandboxes/thread-sandbox-store.js';
import { createTestDb } from '../../helpers/test-db.js';
import { expectOk } from './provider-contract.js';

describe('resolvePublicServerUrl', () => {
  test('prefers FUNNY_PUBLIC_URL, then the Railway public domain', () => {
    expect(
      expectOk(resolvePublicServerUrl({ FUNNY_PUBLIC_URL: 'https://funny.example/app' })),
    ).toBe('https://funny.example');
    expect(expectOk(resolvePublicServerUrl({ RAILWAY_PUBLIC_DOMAIN: 'x.up.railway.app' }))).toBe(
      'https://x.up.railway.app',
    );
  });

  test('refuses missing, invalid, loopback and private addresses', () => {
    for (const env of [
      {},
      { FUNNY_PUBLIC_URL: 'not a url' },
      { FUNNY_PUBLIC_URL: 'http://localhost:3001' },
      { FUNNY_PUBLIC_URL: 'http://192.168.1.10' },
      { FUNNY_PUBLIC_URL: 'http://funny-server.railway.internal' },
    ]) {
      expect(resolvePublicServerUrl(env).isErr()).toBe(true);
    }
  });
});

describe('sqlThreadSandboxStore', () => {
  beforeEach(async () => {
    const testDb = createTestDb();
    const { setConnection } = await import('../../../db/index.js');
    setConnection({
      db: testDb.db as any,
      schema: testDb.schema,
      sqlite: testDb.sqlite,
      mode: 'sqlite',
      close: async () => testDb.sqlite.close(),
    });
  });

  const row = (overrides: Partial<ThreadSandboxRow> = {}): ThreadSandboxRow => ({
    threadId: 't-1',
    userId: 'alice',
    connectionId: 'conn-1',
    provider: 'boat',
    sandboxId: null,
    runnerId: null,
    sizeId: 'default',
    state: 'provisioning',
    error: null,
    generation: 0,
    createdAt: '2026-10-31T00:00:00Z',
    updatedAt: '2026-10-31T00:00:00Z',
    ...overrides,
  });

  test('put, update and get round-trip; put replaces an older generation', async () => {
    expect(expectOk(await sqlThreadSandboxStore.get('t-1'))).toBeNull();
    expectOk(await sqlThreadSandboxStore.put(row()));
    expectOk(await sqlThreadSandboxStore.update('t-1', { state: 'running', runnerId: 'r-box' }));
    expect(expectOk(await sqlThreadSandboxStore.get('t-1'))).toMatchObject({
      state: 'running',
      runnerId: 'r-box',
    });

    expectOk(await sqlThreadSandboxStore.put(row({ generation: 1, state: 'provisioning' })));
    expect(expectOk(await sqlThreadSandboxStore.get('t-1'))).toMatchObject({
      generation: 1,
      state: 'provisioning',
      runnerId: null,
    });
  });

  test('remove drops the row; removing a missing row is fine', async () => {
    expectOk(await sqlThreadSandboxStore.put(row()));
    expectOk(await sqlThreadSandboxStore.remove('t-1'));
    expect(expectOk(await sqlThreadSandboxStore.get('t-1'))).toBeNull();
    expectOk(await sqlThreadSandboxStore.remove('t-1'));
  });
});
