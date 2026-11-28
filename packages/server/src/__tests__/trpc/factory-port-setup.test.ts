import { describe, expect, mock, test } from 'bun:test';

import type { FactoryFlowSetupRow } from '@funny/shared/repositories';
import { err, ok } from 'neverthrow';

import type { FactoryFlowSetupService } from '../../services/factory/factory-flow-setup.js';
import { setupPortMethods, toFlowSetupView } from '../../trpc/ports/factory-port-setup.js';

function makeRow(overrides: Partial<FactoryFlowSetupRow> = {}): FactoryFlowSetupRow {
  return {
    id: 'setup-1',
    projectId: 'p1',
    userId: 'u1',
    flowName: 'issue-to-merge',
    defaultBranch: 'main',
    baseSha: 'abc1234',
    threadId: 't-1',
    branch: 'funny/factory-setup/setup-1',
    worktreePath: '/tmp/wt/t-1',
    runnerId: 'runner-1',
    state: 'proposed',
    startingFile: 'name: issue-to-merge\n',
    startingSource: 'builtin',
    builtinPrompts: JSON.stringify([
      { path: '.funny/workflows/prompts/implement.md', content: 'hi' },
    ]),
    proposedFile: 'name: issue-to-merge\n# rules\n',
    proposedFileSha: 'sha-123',
    commitVariant: null,
    facts: JSON.stringify({
      packageManager: 'pnpm',
      monorepo: 'nx',
      recognized: true,
      summary: 'pnpm + Nx, jest',
      packages: [
        {
          name: 'api',
          root: 'apps/api',
          runner: 'jest',
          configFile: 'apps/api/jest.config.ts',
          nxTestTarget: true,
          testPatterns: ['**/*.spec.ts'],
          sampleTests: ['apps/api/src/a.spec.ts'],
        },
      ],
      testPatterns: ['**/*.spec.ts'],
      infrastructureTests: [{ path: 'apps/api/test/db.e2e-spec.ts', reason: 'e2e' }],
    }),
    verifyJobId: 'job-1',
    verdicts: JSON.stringify({ rules: [], uncovered: [], timedOut: false }),
    error: null,
    commitSha: null,
    prNumber: null,
    prUrl: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    endedAt: null,
    ...overrides,
  };
}

describe('factory-port-setup', () => {
  test('toFlowSetupView parses JSON fields into structured view', () => {
    const view = toFlowSetupView(makeRow());
    expect(view.id).toBe('setup-1');
    expect(view.startingSource).toBe('builtin');
    expect(view.builtinPrompts).toEqual([
      { path: '.funny/workflows/prompts/implement.md', content: 'hi' },
    ]);
    // The runner's `TestStackFacts`, as the browser's contract names them.
    expect(view.facts).toEqual({
      recognized: true,
      packageManager: 'pnpm',
      packages: [
        {
          name: 'api',
          dir: 'apps/api',
          runner: 'jest',
          configFiles: ['apps/api/jest.config.ts'],
          testPatterns: ['**/*.spec.ts'],
        },
      ],
      infraFiles: ['apps/api/test/db.e2e-spec.ts'],
    });
    expect(view.verdicts).toEqual({ rules: [], uncovered: [], timedOut: false });
  });

  test('delegates all 5 setup procedures and maps errors to ApiFailure', async () => {
    const row = makeRow();
    const fakeService: Pick<
      FactoryFlowSetupService,
      | 'startFlowSetup'
      | 'getFlowSetup'
      | 'confirmFlowSetup'
      | 'openFlowSetupPullRequest'
      | 'discardFlowSetup'
    > = {
      startFlowSetup: mock(async () => ok(row)),
      getFlowSetup: mock(async () => row),
      confirmFlowSetup: mock(async () =>
        err({
          kind: 'file-changed' as const,
          status: 409 as const,
          message: 'File changed',
          currentSha: 'sha-new',
          currentFile: 'new-yaml',
        }),
      ),
      openFlowSetupPullRequest: mock(async () => ok(makeRow({ state: 'pr_open', prNumber: 42 }))),
      discardFlowSetup: mock(async () => ok(makeRow({ state: 'discarded' }))),
    };

    const port = setupPortMethods(() => fakeService as FactoryFlowSetupService);

    const started = await port.startFlowSetup('u1', 'p1', 'issue-to-merge');
    expect(started.isOk()).toBe(true);
    expect(started._unsafeUnwrap().id).toBe('setup-1');

    const fetched = await port.flowSetup('u1', 'p1');
    expect(fetched.isOk()).toBe(true);
    expect(fetched._unsafeUnwrap()?.id).toBe('setup-1');

    const confirmed = await port.confirmFlowSetup('u1', 'p1', 'setup-1', 'stale', 'rules');
    expect(confirmed.isErr()).toBe(true);
    expect(confirmed._unsafeUnwrapErr()).toMatchObject({
      status: 409,
      code: 'file-changed',
    });

    const pr = await port.openFlowSetupPullRequest('u1', 'p1', 'setup-1');
    expect(pr.isOk()).toBe(true);
    expect(pr._unsafeUnwrap().prNumber).toBe(42);

    const discarded = await port.discardFlowSetup('u1', 'p1', 'setup-1');
    expect(discarded.isOk()).toBe(true);
    expect(discarded._unsafeUnwrap().state).toBe('discarded');
  });
});
