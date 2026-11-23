/**
 * Each agent step's own options in a run (openspec factory-flow-step-options,
 * tasks 3.1, 3.2, 4.2): on the first thread's create body, on every follow-up
 * body, and `thread: new` steps on threads of their own.
 */
import { describe, expect, test } from 'bun:test';

import { getDefaultModel } from '@funny/shared/models';
import type { SpawnAgentOpts } from '@funny/workflows/compiler';
import { ok, okAsync } from 'neverthrow';

import {
  createFactoryActionProvider,
  type StepAgentBody,
  type StepOptionsEntry,
} from '../../../services/factory/factory-action-provider.js';
import type { StepOverrides } from '../../../services/factory/factory-step-options.js';

const scope = {
  runId: 'r1',
  userId: 'alice',
  projectId: 'p1',
  repo: 'o/r',
  mode: 'local' as const,
  issueNumber: 7,
  issueTitle: 'Fix it',
  branch: 'factory/issue-7-r1',
};

interface Harness {
  threadIds?: string[];
  overrides?: () => StepOverrides;
  findLaunched?: (prefix: string, since: string) => Promise<string | null>;
  launchStartedAt?: string | null;
}

function harness(h: Harness = {}) {
  const launches: Record<string, unknown>[] = [];
  const followUps: Array<{ threadId: string; content: string; options?: StepAgentBody }> = [];
  const recorded: StepOptionsEntry[] = [];
  let next = 0;
  const provider = createFactoryActionProvider({
    scope,
    threadIds: h.threadIds ?? [],
    prUrl: null,
    launchStartedAt: h.launchStartedAt ?? null,
    findLaunched: h.findLaunched ?? (async () => null),
    launch: async (body) => {
      launches.push(body);
      const id = `t${++next}`;
      return ok({ thread: { id }, threadId: id, runnerId: 'r' });
    },
    waitThread: async () => ({ status: 'completed' as const, output: 'done' }),
    continuation: {
      followUp: async (threadId, content, options) => {
        followUps.push({ threadId, content, options });
        return ok(undefined);
      },
      completedAt: async () => null,
      followedUpSince: async () => false,
    },
    stepOverrides: async () => h.overrides?.() ?? {},
    projectDefaults: { provider: 'claude', model: 'sonnet' },
    recordStepOptions: async (entry) => {
      recorded.push(entry);
    },
    github: {
      branchAhead: () => okAsync(true),
      commentOnIssue: () => okAsync(undefined),
      findPullRequest: () => okAsync(null),
      pullRequests: {} as never,
    },
    record: async () => undefined,
    signal: new AbortController().signal,
  });
  return { provider, launches, followUps, recorded };
}

const step = (over: Partial<SpawnAgentOpts>): SpawnAgentOpts => ({
  prompt: 'go',
  cwd: '',
  ...over,
});

describe('agent step options in a run', () => {
  test('the implement step carries its options on the new thread', async () => {
    const { provider, launches } = harness();
    await provider.spawnAgent(
      step({
        stepId: 'implement',
        model: 'opus',
        effort: 'high',
        mode: 'autoEdit',
        disallowedTools: ['WebFetch'],
      }),
    );
    expect(launches[0]).toMatchObject({
      provider: 'claude',
      model: 'opus',
      effort: 'high',
      permissionMode: 'autoEdit',
      disallowedTools: ['WebFetch'],
      branch: scope.branch,
    });
    expect(launches[0]).not.toHaveProperty('allowedTools');
  });

  test("a later step's follow-up carries its own options, not the step before it", async () => {
    const { provider, followUps } = harness();
    await provider.spawnAgent(step({ stepId: 'implement', model: 'opus', effort: 'max' }));
    // A middle step with its own model, then a fix step that sets none.
    await provider.spawnAgent(step({ stepId: 'polish', model: 'haiku' }));
    await provider.spawnAgent(step({ stepId: 'ci.before_retry' }));
    expect(followUps.map((f) => f.threadId)).toEqual(['t1', 't1']);
    expect(followUps[0]!.options).toEqual({
      provider: 'claude',
      model: 'haiku',
      permissionMode: 'autoEdit',
    });
    // Nothing set on the fix step: the project's model, no effort, no tools.
    expect(followUps[1]!.options).toEqual({
      provider: 'claude',
      model: 'sonnet',
      permissionMode: 'autoEdit',
    });
  });

  test('the flow defaults reach a step that sets nothing', async () => {
    const { provider, followUps } = harness();
    const defaults = { model: 'sonnet', disallowedTools: ['Bash'] };
    await provider.spawnAgent(step({ stepId: 'implement', model: 'opus', defaults }));
    await provider.spawnAgent(step({ stepId: 'ci.before_retry', defaults }));
    expect(followUps[0]!.options).toMatchObject({ model: 'sonnet', disallowedTools: ['Bash'] });
  });

  test('an override saved mid-run applies to the steps that have not started', async () => {
    let overrides: StepOverrides = {};
    const { provider, launches, followUps } = harness({ overrides: () => overrides });
    await provider.spawnAgent(step({ stepId: 'implement', model: 'opus' }));
    overrides = { 'ci.before_retry': { model: 'haiku' }, implement: { model: 'sonnet' } };
    await provider.spawnAgent(step({ stepId: 'ci.before_retry', model: 'opus' }));
    expect(launches[0]).toMatchObject({ model: 'opus' });
    expect(followUps[0]!.options).toMatchObject({ model: 'haiku' });
  });

  test('every step records what it ran with', async () => {
    const { provider, recorded } = harness();
    await provider.spawnAgent(step({ stepId: 'implement', model: 'opus' }));
    await provider.spawnAgent(step({ stepId: 'ci.before_retry' }));
    expect(recorded).toEqual([
      expect.objectContaining({ stepId: 'implement', threadId: 't1', model: 'opus' }),
      expect.objectContaining({ stepId: 'ci.before_retry', threadId: 't1', model: 'sonnet' }),
    ]);
  });

  test('a provider change without a model gets that provider’s default model', async () => {
    const { provider, launches } = harness({
      overrides: () => ({ implement: { provider: 'codex' } }),
    });
    await provider.spawnAgent(step({ stepId: 'implement', model: 'opus' }));
    expect(launches[0]).toMatchObject({ provider: 'codex', model: getDefaultModel('codex') });
  });
});

describe('thread: new steps', () => {
  test('run on a thread of their own, off the branch, titled apart; later steps continue the first', async () => {
    const { provider, launches, followUps, recorded } = harness();
    await provider.spawnAgent(step({ stepId: 'implement' }));
    const review = await provider.spawnAgent(
      step({ stepId: 'advise', thread: 'new', mode: 'plan', provider: 'codex' }),
    );
    await provider.spawnAgent(step({ stepId: 'apply', prompt: 'apply it' }));

    expect(launches).toHaveLength(2);
    expect(launches[1]).toMatchObject({
      provider: 'codex',
      permissionMode: 'plan',
      title: '[Factory advise] #7 Fix it',
    });
    expect(launches[1]).not.toHaveProperty('branch');
    expect(launches[1]).toMatchObject({ readOnly: true });
    expect(launches[0]).not.toHaveProperty('readOnly');
    expect(review).toMatchObject({ ok: true, output: 'done' });
    expect(followUps.map((f) => f.threadId)).toEqual(['t1']);
    expect(recorded.map((r) => `${r.stepId}@${r.threadId}:${r.thread}`)).toEqual([
      'implement@t1:continue',
      'advise@t2:new',
      'apply@t1:continue',
    ]);
  });

  test('a resumed run waits on the recorded review thread and starts no other', async () => {
    const { provider, launches, followUps } = harness({ threadIds: ['t1', 'review-thread'] });
    await provider.spawnAgent(step({ stepId: 'implement' }));
    expect(
      await provider.spawnAgent(step({ stepId: 'advise', thread: 'new', mode: 'plan' })),
    ).toMatchObject({ ok: true });
    expect(launches).toEqual([]);
    expect(followUps).toEqual([]);
  });

  test('an interrupted review launch is adopted by its own title, never the implementing one', async () => {
    const prefixes: string[] = [];
    const { provider, launches } = harness({
      threadIds: ['t1'],
      launchStartedAt: '2026-11-23T00:00:00.000Z',
      findLaunched: async (prefix) => {
        prefixes.push(prefix);
        return prefix.startsWith('[Factory advise]') ? 'review-thread' : 't1';
      },
    });
    await provider.spawnAgent(step({ stepId: 'implement' }));
    await provider.spawnAgent(step({ stepId: 'advise', thread: 'new', mode: 'plan' }));
    expect(prefixes).toEqual(['[Factory advise] #7 ']);
    expect(launches).toEqual([]);
  });
});
