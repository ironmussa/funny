import { beforeEach, describe, expect, test } from 'bun:test';

import { createFactoryRunsRepository } from '../../../services/factory/factory-runs.js';
import { createFactorySettingsService } from '../../../services/factory/factory-settings.js';
import { createTestDb, seedProject, seedProjectMember } from '../../helpers/test-db.js';

let testDb: ReturnType<typeof createTestDb>;
let ids = 0;
const settings = () => createFactorySettingsService({ newId: () => `f${++ids}` });

beforeEach(async () => {
  testDb = createTestDb();
  ids = 0;
  const { setConnection } = await import('../../../db/index.js');
  setConnection({
    db: testDb.db as any,
    schema: testDb.schema,
    sqlite: testDb.sqlite,
    mode: 'sqlite',
    close: async () => testDb.sqlite.close(),
  });
  seedProject(testDb.db, { id: 'p1', userId: 'alice' });
  seedProject(testDb.db, { id: 'bob-project', userId: 'bob', path: '/tmp/bob' });
});

describe('factory settings service', () => {
  test('defaults when none configured, then saves and reads back', async () => {
    const svc = settings();
    expect((await svc.get('alice', 'p1'))._unsafeUnwrap()).toBeNull();

    const saved = (
      await svc.save('alice', 'p1', { enabled: true, label: 'ready-for-agent', maxConcurrent: 3 })
    )._unsafeUnwrap();
    expect(saved).toMatchObject({
      projectId: 'p1',
      enabled: true,
      label: 'ready-for-agent',
      flowName: 'issue-to-merge',
      maxConcurrent: 3,
    });
    expect((await svc.get('alice', 'p1'))._unsafeUnwrap()).toEqual(saved);
  });

  test('saving again updates the single row in place', async () => {
    const svc = settings();
    (await svc.save('alice', 'p1', { enabled: true }))._unsafeUnwrap();
    (await svc.save('alice', 'p1', { enabled: false, maxConcurrent: 5 }))._unsafeUnwrap();
    const read = (await svc.get('alice', 'p1'))._unsafeUnwrap();
    expect(read).toMatchObject({ enabled: false, maxConcurrent: 5 });
    const rows = testDb.sqlite.query('SELECT COUNT(*) AS n FROM factory_settings').get() as {
      n: number;
    };
    expect(rows.n).toBe(1);
  });

  test('a project member (not owner) can run their own factory; an outsider cannot', async () => {
    const svc = settings();
    seedProjectMember(testDb.db, { projectId: 'bob-project', userId: 'alice', role: 'member' });
    expect(
      (await svc.save('alice', 'bob-project', { enabled: true }))._unsafeUnwrap().enabled,
    ).toBe(true);
    const outsider = await svc.save('carol', 'bob-project', { enabled: true });
    expect(outsider.isErr() && outsider.error.kind).toBe('not-found');
  });

  test('a viewer member can read but not enable a factory', async () => {
    const svc = settings();
    // `setMemberLocalPath` writes viewer rows like this one for org viewers.
    seedProjectMember(testDb.db, { projectId: 'bob-project', userId: 'alice', role: 'viewer' });
    expect((await svc.get('alice', 'bob-project'))._unsafeUnwrap()).toBeNull();
    const saved = await svc.save('alice', 'bob-project', { enabled: true });
    expect(saved.isErr() && saved.error.kind).toBe('forbidden');
    const rows = testDb.sqlite.query('SELECT COUNT(*) AS n FROM factory_settings').get() as {
      n: number;
    };
    expect(rows.n).toBe(0);
  });

  test('each user keeps their own factory for the same project', async () => {
    const svc = settings();
    seedProjectMember(testDb.db, { projectId: 'p1', userId: 'bob', role: 'member' });
    (await svc.save('alice', 'p1', { enabled: true, label: 'alice-label' }))._unsafeUnwrap();
    (await svc.save('bob', 'p1', { enabled: false, label: 'bob-label' }))._unsafeUnwrap();
    expect((await svc.get('alice', 'p1'))._unsafeUnwrap()?.label).toBe('alice-label');
    expect((await svc.get('bob', 'p1'))._unsafeUnwrap()?.label).toBe('bob-label');
  });

  test('rejects an empty label and an out-of-range concurrency', async () => {
    const svc = settings();
    expect((await svc.save('alice', 'p1', { enabled: true, label: '  ' })).isErr()).toBe(true);
    expect((await svc.save('alice', 'p1', { enabled: true, maxConcurrent: 0 })).isErr()).toBe(true);
    expect((await svc.save('alice', 'p1', { enabled: true, maxConcurrent: 99 })).isErr()).toBe(
      true,
    );
  });
});

describe('factory runs repository', () => {
  const runs = () => createFactoryRunsRepository({ newId: () => `r${++ids}` });

  const makeFactory = async (): Promise<string> => {
    (await settings().save('alice', 'p1', { enabled: true }))._unsafeUnwrap();
    return (testDb.sqlite.query('SELECT id FROM factory_settings LIMIT 1').get() as { id: string })
      .id;
  };

  test('one active run per issue; terminal frees the issue', async () => {
    const repo = runs();
    const factoryId = await makeFactory();
    const run = (
      await repo.start({ factoryId, issueNumber: 42, currentStep: 'implement' })
    )._unsafeUnwrap();
    expect((await repo.activeByIssue(factoryId, 42))._unsafeUnwrap()?.id).toBe(run.id);
    expect((await repo.countActive(factoryId))._unsafeUnwrap()).toBe(1);

    (await repo.update(run.id, { state: 'merged' }))._unsafeUnwrap();
    expect((await repo.activeByIssue(factoryId, 42))._unsafeUnwrap()).toBeNull();
    expect((await repo.countActive(factoryId))._unsafeUnwrap()).toBe(0);
  });

  test('update records state, step, pr and thread ids; completedAt on terminal', async () => {
    const repo = runs();
    const factoryId = await makeFactory();
    const run = (await repo.start({ factoryId, issueNumber: 7 }))._unsafeUnwrap();
    (
      await repo.update(run.id, {
        state: 'pr_open',
        currentStep: 'review',
        prUrl: 'https://x/pr/1',
        threadIds: ['t1', 't2'],
      })
    )._unsafeUnwrap();
    const [listed] = (await repo.list(factoryId))._unsafeUnwrap();
    expect(listed).toMatchObject({
      state: 'pr_open',
      currentStep: 'review',
      prUrl: 'https://x/pr/1',
      threadIds: ['t1', 't2'],
      completedAt: null,
    });
    (await repo.update(run.id, { state: 'failed' }))._unsafeUnwrap();
    expect((await repo.list(factoryId))._unsafeUnwrap()[0]?.completedAt).not.toBeNull();
  });

  test('stopMany terminal-marks the given runs', async () => {
    const repo = runs();
    const factoryId = await makeFactory();
    const a = (await repo.start({ factoryId, issueNumber: 1 }))._unsafeUnwrap();
    const b = (await repo.start({ factoryId, issueNumber: 2 }))._unsafeUnwrap();
    (await repo.stopMany([a.id, b.id]))._unsafeUnwrap();
    expect((await repo.countActive(factoryId))._unsafeUnwrap()).toBe(0);
  });
});
