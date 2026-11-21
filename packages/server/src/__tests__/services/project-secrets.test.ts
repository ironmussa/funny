/**
 * Project secrets service (openspec project-secrets): management rules and
 * what a thread's runner receives. Real in-memory SQLite, fake keyring.
 */
import { beforeEach, describe, expect, spyOn, test } from 'bun:test';

import { SECRET_MAX_PER_SCOPE } from '@funny/shared/project-secrets';
import { eq } from 'drizzle-orm';

import { projectSecrets, projects } from '../../db/schema.js';
import { log } from '../../lib/logger.js';
import { createProjectSecretsService } from '../../services/project-secrets.js';
import { createTestDb, seedProject, seedProjectMember, seedThread } from '../helpers/test-db.js';

let testDb: ReturnType<typeof createTestDb>;
let ids = 0;
/** Runner id → the thread a sandbox runner is bound to. */
let sandboxRunners: Record<string, string> = {};
let activeKey = 'k1';

/** `enc:<key>:<plaintext reversed>`: not the plaintext, and readable back. */
const fakeCrypto = {
  encrypt: (plain: string) => `enc:${activeKey}:${[...plain].reverse().join('')}`,
  decrypt: (stored: string) => {
    const match = /^enc:[^:]+:([\s\S]*)$/.exec(stored);
    return match ? [...match[1]].reverse().join('') : null;
  },
  isEncryptedWithActiveKey: (stored: string) => stored.startsWith(`enc:${activeKey}:`),
};

const service = () =>
  createProjectSecretsService({
    newId: () => `s${++ids}`,
    crypto: fakeCrypto,
    sandboxThreadOfRunner: async (runnerId) => sandboxRunners[runnerId] ?? null,
  });

const stored = () => testDb.db.select().from(projectSecrets).all();

function auditEntries(spy: ReturnType<typeof spyOn>, action: string) {
  return spy.mock.calls
    .filter(([message]: [string]) => message === `[AUDIT] ${action}`)
    .map(([, meta]: [string, Record<string, unknown>]) => meta);
}

beforeEach(async () => {
  testDb = createTestDb();
  ids = 0;
  sandboxRunners = {};
  activeKey = 'k1';
  const { setConnection } = await import('../../db/index.js');
  setConnection({
    db: testDb.db,
    schema: testDb.schema,
    sqlite: testDb.sqlite,
    mode: 'sqlite',
    close: async () => testDb.sqlite.close(),
  });
  // alice owns p1; bob is an admin, carol a contributor, dave a viewer.
  seedProject(testDb.db, { id: 'p1', userId: 'alice' });
  seedProjectMember(testDb.db, { projectId: 'p1', userId: 'bob', role: 'admin' });
  seedProjectMember(testDb.db, { projectId: 'p1', userId: 'carol', role: 'member' });
  seedProjectMember(testDb.db, { projectId: 'p1', userId: 'dave', role: 'viewer' });
});

const shared = (name: string, value: string | undefined, allowInSandbox = false) =>
  ({ projectId: 'p1', scope: 'project', name, value, allowInSandbox }) as const;
const personal = (name: string, value: string | undefined, allowInSandbox = false) =>
  ({ projectId: 'p1', scope: 'user', name, value, allowInSandbox }) as const;

describe('managing project secrets', () => {
  test('stores the value encrypted and never lists it', async () => {
    const svc = service();
    const saved = (await svc.set('alice', shared('API_KEY', 'super-secret')))._unsafeUnwrap();
    expect(saved).toMatchObject({ name: 'API_KEY', scope: 'project', allowInSandbox: false });

    const [row] = stored();
    expect(row.ciphertext).not.toContain('super-secret');
    expect(row.userId).toBe('');

    const listed = (await svc.list('alice', 'p1'))._unsafeUnwrap();
    expect(listed).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain('super-secret');
    expect(JSON.stringify(listed)).not.toContain(row.ciphertext);
  });

  test('saving an existing name replaces its value and creates no second row', async () => {
    const svc = service();
    (await svc.set('alice', shared('API_KEY', 'first')))._unsafeUnwrap();
    (await svc.set('bob', shared('API_KEY', 'second')))._unsafeUnwrap();
    const rows = stored();
    expect(rows).toHaveLength(1);
    expect(fakeCrypto.decrypt(rows[0].ciphertext)).toBe('second');
    expect(rows[0].updatedBy).toBe('bob');
  });

  test('changes the sandbox setting without a value and keeps the stored one', async () => {
    const svc = service();
    (await svc.set('alice', shared('API_KEY', 'keep-me')))._unsafeUnwrap();
    const changed = (await svc.set('alice', shared('API_KEY', undefined, true)))._unsafeUnwrap();
    expect(changed.allowInSandbox).toBe(true);
    expect(fakeCrypto.decrypt(stored()[0].ciphertext)).toBe('keep-me');
  });

  test('a new secret needs a value', async () => {
    const result = await service().set('alice', shared('API_KEY', undefined));
    expect(result.isErr() && result.error.kind).toBe('invalid');
    expect(stored()).toHaveLength(0);
  });

  test('refuses reserved and malformed names', async () => {
    const svc = service();
    for (const name of ['NODE_OPTIONS', 'LD_PRELOAD', 'PATH', 'GH_TOKEN', 'ANTHROPIC_BASE_URL']) {
      const result = await svc.set('alice', shared(name, 'v'));
      expect(result.isErr() && result.error.kind).toBe('invalid');
    }
    const malformed = await svc.set('alice', shared('MY-TOKEN', 'v'));
    expect(malformed.isErr() && malformed.error.kind).toBe('invalid');
    expect(stored()).toHaveLength(0);
  });

  test('a shared and a personal secret may share a name', async () => {
    const svc = service();
    (await svc.set('alice', shared('DATABASE_URL', 'shared')))._unsafeUnwrap();
    (await svc.set('carol', personal('DATABASE_URL', 'carols')))._unsafeUnwrap();
    (await svc.set('bob', personal('DATABASE_URL', 'bobs')))._unsafeUnwrap();
    expect(stored()).toHaveLength(3);
  });

  test('shared secrets need manage; personal ones need steer', async () => {
    const svc = service();
    const contributor = await svc.set('carol', shared('API_KEY', 'v'));
    expect(contributor.isErr() && contributor.error.kind).toBe('forbidden');
    expect((await svc.set('bob', shared('API_KEY', 'v'))).isOk()).toBe(true);

    expect((await svc.set('carol', personal('MINE', 'v'))).isOk()).toBe(true);
    const viewer = await svc.set('dave', personal('MINE', 'v'));
    expect(viewer.isErr() && viewer.error.kind).toBe('forbidden');
  });

  test('a user without a role gets not-found for every operation', async () => {
    const svc = service();
    const id = (await svc.set('alice', shared('API_KEY', 'v')))._unsafeUnwrap().id;
    const listed = await svc.list('mallory', 'p1');
    expect(listed.isErr() && listed.error.kind).toBe('not-found');
    const saved = await svc.set('mallory', personal('MINE', 'v'));
    expect(saved.isErr() && saved.error.kind).toBe('not-found');
    const removed = await svc.remove('mallory', 'p1', id);
    expect(removed.isErr() && removed.error.kind).toBe('not-found');
    expect(stored()).toHaveLength(1);
  });

  test("another member's personal secrets are neither listed nor deletable", async () => {
    const svc = service();
    const carols = (await svc.set('carol', personal('MINE', 'v')))._unsafeUnwrap();
    (await svc.set('alice', shared('API_KEY', 'v')))._unsafeUnwrap();

    const listedByBob = (await svc.list('bob', 'p1'))._unsafeUnwrap();
    expect(listedByBob.map((s) => s.name)).toEqual(['API_KEY']);

    // bob is an admin, and still cannot delete carol's personal secret.
    const removed = await svc.remove('bob', 'p1', carols.id);
    expect(removed.isErr() && removed.error.kind).toBe('not-found');
    expect((await svc.remove('carol', 'p1', carols.id)).isOk()).toBe(true);
  });

  test('a contributor cannot delete a shared secret; a viewer can list it', async () => {
    const svc = service();
    const id = (await svc.set('alice', shared('API_KEY', 'v')))._unsafeUnwrap().id;
    const removed = await svc.remove('carol', 'p1', id);
    expect(removed.isErr() && removed.error.kind).toBe('forbidden');
    expect((await svc.list('dave', 'p1'))._unsafeUnwrap()).toHaveLength(1);
    expect((await svc.remove('bob', 'p1', id)).isOk()).toBe(true);
    expect(stored()).toHaveLength(0);
  });

  test('holds at most the limit per scope, and still updates an existing one', async () => {
    const svc = service();
    const now = new Date().toISOString();
    for (let i = 0; i < SECRET_MAX_PER_SCOPE; i++) {
      testDb.db
        .insert(projectSecrets)
        .values({
          id: `seed${i}`,
          projectId: 'p1',
          scope: 'project',
          userId: '',
          name: `NAME_${i}`,
          ciphertext: fakeCrypto.encrypt('v'),
          allowInSandbox: 0,
          updatedBy: 'alice',
          createdAt: now,
          updatedAt: now,
        })
        .run();
    }
    const over = await svc.set('alice', shared('ONE_MORE', 'v'));
    expect(over.isErr() && over.error.kind).toBe('invalid');
    expect((await svc.set('alice', shared('NAME_0', 'changed'))).isOk()).toBe(true);
    // The personal scope has its own count.
    expect((await svc.set('alice', personal('ONE_MORE', 'v'))).isOk()).toBe(true);
  });

  test('audits a save and a delete with the name and scope, never the value', async () => {
    const info = spyOn(log, 'info');
    const svc = service();
    const saved = (await svc.set('alice', shared('API_KEY', 'super-secret')))._unsafeUnwrap();
    (await svc.remove('alice', 'p1', saved.id))._unsafeUnwrap();

    expect(auditEntries(info, 'secret.set')).toEqual([
      expect.objectContaining({
        actorId: 'alice',
        projectId: 'p1',
        secretName: 'API_KEY',
        scope: 'project',
      }),
    ]);
    expect(auditEntries(info, 'secret.delete')).toEqual([
      expect.objectContaining({ actorId: 'alice', projectId: 'p1', secretName: 'API_KEY' }),
    ]);
    expect(JSON.stringify(info.mock.calls)).not.toContain('super-secret');
    info.mockRestore();
  });

  test("removing a member drops only that member's personal secrets", async () => {
    const svc = service();
    (await svc.set('alice', shared('API_KEY', 'v')))._unsafeUnwrap();
    (await svc.set('carol', personal('MINE', 'v')))._unsafeUnwrap();
    (await svc.set('bob', personal('MINE', 'v')))._unsafeUnwrap();
    const { removeMember } = await import('../../services/project-manager.js');
    await removeMember('p1', 'carol');
    expect(
      stored()
        .map((row) => `${row.scope}:${row.userId}`)
        .sort(),
    ).toEqual(['project:', 'user:bob']);
  });

  test('deleting the project deletes its secrets', async () => {
    const svc = service();
    (await svc.set('alice', shared('API_KEY', 'v')))._unsafeUnwrap();
    (await svc.set('carol', personal('MINE', 'v')))._unsafeUnwrap();
    testDb.db.delete(projects).where(eq(projects.id, 'p1')).run();
    expect(stored()).toHaveLength(0);
  });
});

describe('resolveThreadSecrets', () => {
  const ask = (threadId: string, runnerId: string, runnerOwnerId: string) =>
    service().resolveThreadSecrets({ threadId, runnerId, runnerOwnerId });

  beforeEach(() => {
    seedThread(testDb.db, { id: 't-carol', projectId: 'p1', userId: 'carol' });
    seedThread(testDb.db, { id: 't-sandbox', projectId: 'p1', userId: 'carol' });
    seedThread(testDb.db, { id: 't-scratch', projectId: null, userId: 'carol', isScratch: 1 });
    sandboxRunners = { 'r-sandbox': 't-sandbox' };
  });

  test("delivers the shared secrets and the thread owner's personal ones, personal first", async () => {
    const svc = service();
    (await svc.set('alice', shared('API_KEY', 'shared-api')))._unsafeUnwrap();
    (await svc.set('alice', shared('DATABASE_URL', 'shared-db')))._unsafeUnwrap();
    (await svc.set('carol', personal('DATABASE_URL', 'carol-db')))._unsafeUnwrap();
    (await svc.set('bob', personal('DATABASE_URL', 'bob-db')))._unsafeUnwrap();
    (await svc.set('bob', personal('ONLY_BOB', 'bob-only')))._unsafeUnwrap();

    expect((await ask('t-carol', 'r-carol', 'carol'))._unsafeUnwrap()).toEqual([
      { name: 'API_KEY', value: 'shared-api' },
      { name: 'DATABASE_URL', value: 'carol-db' },
    ]);
  });

  test('refuses a runner that is not the thread owner’s, and audits it', async () => {
    const info = spyOn(log, 'info');
    (await service().set('alice', shared('API_KEY', 'shared-api')))._unsafeUnwrap();
    const result = await ask('t-carol', 'r-bob', 'bob');
    expect(result.isErr() && result.error.kind).toBe('refused');
    expect(auditEntries(info, 'secret.delivery_refused')).toEqual([
      expect.objectContaining({ actorId: 'bob', threadId: 't-carol', runnerId: 'r-bob' }),
    ]);
    info.mockRestore();
  });

  test('refuses an unknown thread', async () => {
    const result = await ask('nope', 'r-carol', 'carol');
    expect(result.isErr() && result.error.kind).toBe('refused');
  });

  test('a scratch thread receives nothing', async () => {
    (await service().set('alice', shared('API_KEY', 'shared-api')))._unsafeUnwrap();
    expect((await ask('t-scratch', 'r-carol', 'carol'))._unsafeUnwrap()).toEqual([]);
  });

  test('a sandbox runner receives only secrets allowed in sandboxes', async () => {
    const svc = service();
    (await svc.set('alice', shared('ALLOWED', 'allowed-value', true)))._unsafeUnwrap();
    (await svc.set('alice', shared('LOCAL_ONLY', 'local-value')))._unsafeUnwrap();
    expect((await ask('t-sandbox', 'r-sandbox', 'carol'))._unsafeUnwrap()).toEqual([
      { name: 'ALLOWED', value: 'allowed-value' },
    ]);
  });

  test('a personal secret that is off in sandboxes also hides the shared value', async () => {
    const svc = service();
    (await svc.set('alice', shared('DATABASE_URL', 'shared-db', true)))._unsafeUnwrap();
    (await svc.set('carol', personal('DATABASE_URL', 'carol-db', false)))._unsafeUnwrap();
    expect((await ask('t-sandbox', 'r-sandbox', 'carol'))._unsafeUnwrap()).toEqual([]);
  });

  test('a sandbox runner is refused for a thread it is not bound to', async () => {
    (await service().set('alice', shared('ALLOWED', 'allowed-value', true)))._unsafeUnwrap();
    const result = await ask('t-carol', 'r-sandbox', 'carol');
    expect(result.isErr() && result.error.kind).toBe('refused');
  });

  test('a name that became reserved after it was saved is not delivered', async () => {
    const now = new Date().toISOString();
    testDb.db
      .insert(projectSecrets)
      .values({
        id: 'legacy',
        projectId: 'p1',
        scope: 'project',
        userId: '',
        name: 'NODE_OPTIONS',
        ciphertext: fakeCrypto.encrypt('--require evil'),
        allowInSandbox: 1,
        updatedBy: 'alice',
        createdAt: now,
        updatedAt: now,
      })
      .run();
    expect((await ask('t-carol', 'r-carol', 'carol'))._unsafeUnwrap()).toEqual([]);
  });

  test('one undecryptable secret fails the whole delivery and names it', async () => {
    const svc = service();
    (await svc.set('alice', shared('GOOD', 'good-value')))._unsafeUnwrap();
    (await svc.set('alice', shared('BROKEN', 'broken-value')))._unsafeUnwrap();
    testDb.db
      .update(projectSecrets)
      .set({ ciphertext: 'garbage' })
      .where(eq(projectSecrets.name, 'BROKEN'))
      .run();
    const result = await ask('t-carol', 'r-carol', 'carol');
    expect(result.isErr() && result.error).toMatchObject({
      kind: 'undecryptable',
      secretName: 'BROKEN',
    });
  });

  test('re-encrypts a secret read with an older key', async () => {
    (await service().set('alice', shared('API_KEY', 'shared-api')))._unsafeUnwrap();
    activeKey = 'k2';
    expect((await ask('t-carol', 'r-carol', 'carol'))._unsafeUnwrap()).toHaveLength(1);
    await Bun.sleep(10);
    expect(stored()[0].ciphertext.startsWith('enc:k2:')).toBe(true);
    expect(fakeCrypto.decrypt(stored()[0].ciphertext)).toBe('shared-api');
  });

  test('audits a delivery with thread, runner and names, never values', async () => {
    const info = spyOn(log, 'info');
    (await service().set('alice', shared('API_KEY', 'shared-api')))._unsafeUnwrap();
    (await ask('t-carol', 'r-carol', 'carol'))._unsafeUnwrap();
    expect(auditEntries(info, 'secret.delivered')).toEqual([
      expect.objectContaining({
        actorId: 'carol',
        threadId: 't-carol',
        runnerId: 'r-carol',
        secretNames: ['API_KEY'],
      }),
    ]);
    expect(JSON.stringify(info.mock.calls)).not.toContain('shared-api');
    info.mockRestore();
  });
});
