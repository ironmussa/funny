import { describe, expect, test } from 'bun:test';

import {
  FACTORY_FLOW_SETUP_STATES,
  FACTORY_FLOW_SETUP_WRITTEN_FROM,
  type FactoryFlowSetupState,
} from '../../factory-flow-setup-machine.js';
import {
  createFactoryFlowSetupRepository,
  type FactoryFlowSetupInsert,
} from '../../repositories/factory-flow-setup-repository.js';
import { createTestDb, seedProject, seedThread } from '../helpers/test-db.js';

function makeSetup(overrides: Partial<FactoryFlowSetupInsert> = {}): FactoryFlowSetupInsert {
  const now = new Date().toISOString();
  return {
    id: overrides.id ?? 'setup-1',
    projectId: overrides.projectId ?? 'p1',
    userId: overrides.userId ?? 'user-1',
    flowName: overrides.flowName ?? 'issue-to-merge',
    defaultBranch: overrides.defaultBranch ?? 'main',
    baseSha: overrides.baseSha ?? 'abc1234',
    threadId: overrides.threadId ?? null,
    branch: overrides.branch ?? 'funny/factory-setup/setup-1',
    worktreePath: overrides.worktreePath ?? null,
    runnerId: overrides.runnerId ?? 'runner-1',
    state: overrides.state ?? 'generating',
    startingFile: overrides.startingFile ?? 'name: issue-to-merge\n',
    startingSource: overrides.startingSource ?? 'builtin',
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
    ...overrides,
  };
}

describe('factory-flow-setup-repository', () => {
  test('allows every legal transition in FACTORY_FLOW_SETUP_WRITTEN_FROM', async () => {
    for (const toState of FACTORY_FLOW_SETUP_STATES) {
      const legalFroms = FACTORY_FLOW_SETUP_WRITTEN_FROM[toState];
      for (const fromState of legalFroms) {
        const ctx = createTestDb();
        seedProject(ctx.db);
        const repo = createFactoryFlowSetupRepository(ctx);
        const id = `s-${fromState}-to-${toState}`;
        await repo.insert(makeSetup({ id, state: fromState }));

        const ok = await repo.transition(id, toState);
        expect(ok).toBe(true);

        const row = await repo.getById(id);
        expect(row?.state).toBe(toState);
        if (toState === 'committed' || toState === 'discarded' || toState === 'failed') {
          expect(row?.endedAt).not.toBeNull();
        } else {
          expect(row?.endedAt).toBeNull();
        }
      }
    }
  });

  test('refuses every illegal transition and leaves stored state unchanged', async () => {
    const ctx = createTestDb();
    seedProject(ctx.db);
    const repo = createFactoryFlowSetupRepository(ctx);

    let idx = 0;
    for (const fromState of FACTORY_FLOW_SETUP_STATES) {
      for (const toState of FACTORY_FLOW_SETUP_STATES) {
        const legal = FACTORY_FLOW_SETUP_WRITTEN_FROM[toState].includes(fromState);
        if (legal) continue;
        idx += 1;
        const id = `illegal-${idx}`;
        await repo.insert(makeSetup({ id, flowName: `flow-${idx}`, state: fromState }));

        const ok = await repo.transition(id, toState);
        expect(ok).toBe(false);

        const row = await repo.getById(id);
        expect(row?.state).toBe(fromState);
      }
    }
  });

  test('enforces proposedFileSha compare-and-set on transition', async () => {
    const ctx = createTestDb();
    seedProject(ctx.db);
    const repo = createFactoryFlowSetupRepository(ctx);

    await repo.insert(
      makeSetup({
        id: 's-sha',
        state: 'proposed',
        proposedFile: 'name: issue-to-merge\n',
        proposedFileSha: 'sha-v1',
      }),
    );

    const wrongSha = await repo.transition(
      's-sha',
      'committing',
      { commitVariant: 'rules' },
      { fromState: 'proposed', proposedFileSha: 'sha-stale' },
    );
    expect(wrongSha).toBe(false);
    expect((await repo.getById('s-sha'))?.state).toBe('proposed');

    const rightSha = await repo.transition(
      's-sha',
      'committing',
      { commitVariant: 'rules' },
      { fromState: 'proposed', proposedFileSha: 'sha-v1' },
    );
    expect(rightSha).toBe(true);
    const updated = await repo.getById('s-sha');
    expect(updated?.state).toBe('committing');
    expect(updated?.commitVariant).toBe('rules');
  });

  test('enforces one open setup per (member, project, flow)', async () => {
    const ctx = createTestDb();
    seedProject(ctx.db, { id: 'p1' });
    seedProject(ctx.db, { id: 'p2' });
    const repo = createFactoryFlowSetupRepository(ctx);

    await repo.insert(makeSetup({ id: 'open-1', projectId: 'p1', userId: 'u1', flowName: 'f1' }));

    // Same (user, project, flow) while open → rejected by partial unique index.
    await expect(
      repo.insert(makeSetup({ id: 'open-dup', projectId: 'p1', userId: 'u1', flowName: 'f1' })),
    ).rejects.toThrow();

    // Different user, different flow, or different project → all allowed.
    await repo.insert(
      makeSetup({ id: 'other-user', projectId: 'p1', userId: 'u2', flowName: 'f1' }),
    );
    await repo.insert(
      makeSetup({ id: 'other-flow', projectId: 'p1', userId: 'u1', flowName: 'f2' }),
    );
    await repo.insert(
      makeSetup({ id: 'other-proj', projectId: 'p2', userId: 'u1', flowName: 'f1' }),
    );

    // Once the first setup ends (failed, discarded, or committed), a new open one is allowed.
    expect(await repo.transition('open-1', 'failed', { error: 'no rules' })).toBe(true);
    expect(await repo.getOpenByUserProjectFlow('u1', 'p1', 'f1')).toBeUndefined();

    await repo.insert(makeSetup({ id: 'open-2', projectId: 'p1', userId: 'u1', flowName: 'f1' }));
    const open = await repo.getOpenByUserProjectFlow('u1', 'p1', 'f1');
    expect(open?.id).toBe('open-2');
  });

  test('supports lookup by threadId, latest lookup, listByStates, and non-state update', async () => {
    const ctx = createTestDb();
    seedProject(ctx.db);
    seedThread(ctx.db, { id: 't-setup' });
    const repo = createFactoryFlowSetupRepository(ctx);

    await repo.insert(
      makeSetup({
        id: 's1',
        state: 'failed',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        endedAt: '2026-01-01T00:05:00.000Z',
      }),
    );
    await repo.insert(
      makeSetup({
        id: 's2',
        threadId: 't-setup',
        state: 'verifying',
        createdAt: '2026-01-02T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z',
      }),
    );

    expect((await repo.getByThreadId('t-setup'))?.id).toBe('s2');
    expect((await repo.getLatestByUserProjectFlow('user-1', 'p1', 'issue-to-merge'))?.id).toBe(
      's2',
    );

    expect(await repo.update('s2', { verifyJobId: 'job-99', worktreePath: '/tmp/wt' })).toBe(true);
    const afterUpdate = await repo.getById('s2');
    expect(afterUpdate?.verifyJobId).toBe('job-99');
    expect(afterUpdate?.worktreePath).toBe('/tmp/wt');
    expect(afterUpdate?.state).toBe('verifying');

    const states: FactoryFlowSetupState[] = ['verifying', 'committing', 'pr_open'];
    const reconciling = await repo.listByStates(states);
    expect(reconciling.map((r) => r.id)).toEqual(['s2']);
  });
});
