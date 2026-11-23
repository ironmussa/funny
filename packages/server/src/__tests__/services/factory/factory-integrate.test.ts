/**
 * The `integrate` step on the server (openspec factory-integration 3.2-3.4b):
 * it asks the run's runner, reads the outcome, keeps the review of a merge that
 * settled nothing, and scopes the next review to what a merge settled.
 */
import { describe, expect, test } from 'bun:test';

import { EMPTY_FACTORY_RUN_METRICS, type FactoryRunMetrics } from '@funny/shared/contracts/factory';
import { EMPTY_INTEGRATE_CONFIG, type IntegrateConfig } from '@funny/workflows';
import { ok } from 'neverthrow';

import { loadFactoryFlow, type FactoryFlowError } from '../../../services/factory/factory-flow.js';
import { createFactoryIntegrate } from '../../../services/factory/factory-integrate.js';
import type { FactoryStepDeps } from '../../../services/factory/factory-step-runner.js';

const integrateResult = (over: Record<string, unknown> = {}) => ({
  kind: 'integrate',
  outcome: 'merged',
  headBefore: 'a'.repeat(40),
  headAfter: 'b'.repeat(40),
  resolvedPaths: [],
  regeneratedPaths: [],
  conflictedPaths: [],
  baseDiff: '',
  weave: false,
  message: 'ok',
  ...over,
});

function setup(result: Record<string, unknown>, config: IntegrateConfig = EMPTY_INTEGRATE_CONFIG) {
  const started: Array<Record<string, unknown>> = [];
  const carried: Array<[string, string]> = [];
  let metrics: FactoryRunMetrics = { ...EMPTY_FACTORY_RUN_METRICS };
  const steps: FactoryStepDeps = {
    startStep: async (_threadId, body) => {
      started.push(body);
      return ok({ stepId: 's1', state: 'running' });
    },
    pollStep: async () => ok({ state: 'done', result }),
    pollMs: 1,
  };
  const integration = createFactoryIntegrate({
    steps,
    threadId: () => 'impl',
    branch: 'factory/issue-7-r1',
    defaultBranch: () => Promise.resolve(ok('main')),
    config,
    signal: new AbortController().signal,
    metrics: () => metrics,
    count: async (next) => {
      metrics = next;
    },
    carry: async (from, to) => {
      carried.push([from, to]);
    },
  });
  return { integration, started, carried, metrics: () => metrics };
}

describe('integrate', () => {
  test('asks the runner to merge the default branch into the run branch with the config', async () => {
    const config = {
      regenerators: [{ paths: ['bun.lock'], run: 'bun install', timeoutMs: 600_000 }],
      checks: ['bun run typecheck'],
    };
    const { integration, started } = setup(integrateResult({ outcome: 'up-to-date' }), config);
    const result = await integration.integrate();
    expect(result).toMatchObject({ ok: true, metadata: { outcome: 'up-to-date' } });
    expect(started[0]).toMatchObject({
      kind: 'integrate',
      baseBranch: 'main',
      branch: 'factory/issue-7-r1',
      regenerators: config.regenerators,
      checks: config.checks,
    });
  });

  test('a merge that settled nothing keeps the review of the commit before it', async () => {
    const { integration, carried, metrics } = setup(integrateResult());
    expect((await integration.integrate()).ok).toBe(true);
    expect(carried).toEqual([['a'.repeat(40), 'b'.repeat(40)]]);
    expect(integration.integrationOf('b'.repeat(40))).toBeNull();
    expect(metrics()).toMatchObject({ integrateRounds: 1, conflictsResolvedWithoutLlm: 0 });
  });

  test('a merge that settled conflicts is reviewed again, only where it settled them', async () => {
    const { integration, carried, metrics } = setup(
      integrateResult({ resolvedPaths: ['src/a.ts'], regeneratedPaths: ['bun.lock'] }),
    );
    expect((await integration.integrate()).ok).toBe(true);
    expect(carried).toEqual([]);
    expect(integration.integrationOf('b'.repeat(40))).toEqual({
      from: 'a'.repeat(40),
      paths: ['src/a.ts', 'bun.lock'],
    });
    expect(metrics()).toMatchObject({ integrateRounds: 1, conflictsResolvedWithoutLlm: 1 });
  });

  test('a real conflict passes with feedback for the implementer, so the loop can send it', async () => {
    const { integration, carried, metrics } = setup(
      integrateResult({
        outcome: 'conflict',
        headAfter: 'a'.repeat(40),
        conflictedPaths: ['src/a.ts'],
        baseDiff: '+base line',
      }),
    );
    const result = await integration.integrate();
    expect(result).toMatchObject({
      ok: true,
      output: 'conflict',
      metadata: { outcome: 'conflict' },
    });
    const feedback = String(result.metadata?.feedback);
    expect(feedback).toContain('- src/a.ts');
    expect(feedback).toContain('+base line');
    expect(feedback).toContain('never a rebase');
    expect(carried).toEqual([]);
    expect(metrics()).toMatchObject({ integrateRounds: 1, conflictsSentToAgent: 1 });
  });

  test('a failed integration fails the step', async () => {
    const { integration } = setup(integrateResult({ outcome: 'failed', message: 'check failed' }));
    expect(await integration.integrate()).toMatchObject({ ok: false, error: 'check failed' });
  });
});

describe('.funny/integrate.yaml with the flow', () => {
  const flowYaml = `name: custom
nodes:
  - id: implement
    spawn_agent: { prompt: go }
  - id: integrate
    depends_on: [implement]
    integrate: {}
`;
  const reads = (integrateYaml: string | null) => ({
    readDefaultBranchFile: async (path: string) => {
      if (path === '.funny/workflows/custom.yaml') return ok(flowYaml);
      if (path === '.funny/integrate.yaml') return ok(integrateYaml);
      return ok(null);
    },
  });
  const invalid = (error: FactoryFlowError) => {
    if (error.kind !== 'invalid') throw new Error(`expected invalid, got ${error.kind}`);
    return error;
  };

  test('a valid file is loaded with the flow', async () => {
    const loaded = await loadFactoryFlow(
      'custom',
      reads('regenerate:\n  - paths: [bun.lock]\n    run: bun install\n'),
    );
    expect(loaded._unsafeUnwrap().integrate.regenerators).toEqual([
      { paths: ['bun.lock'], run: 'bun install', timeoutMs: 600_000 },
    ]);
  });

  test('no file: nothing is regenerated', async () => {
    const loaded = await loadFactoryFlow('custom', reads(null));
    expect(loaded._unsafeUnwrap().integrate).toEqual({ regenerators: [], checks: [] });
  });

  test('an invalid file fails the load, naming the file and field', async () => {
    const loaded = await loadFactoryFlow(
      'custom',
      reads('regenerate:\n  - paths: ["pkgs/[ab]/x.lock"]\n    run: bun install\n'),
    );
    expect(invalid(loaded._unsafeUnwrapErr()).problems).toEqual([
      {
        step: '.funny/integrate.yaml',
        field: 'regenerate[0].paths[0]',
        message: expect.any(String),
      },
    ]);
  });
});
