/**
 * The server factory's flows: `issue-to-merge` (the default) and
 * `issue-to-pr`, built-ins that compile, and the CI fix
 * loop of `issue-to-merge` — red runs a fix agent with the failing log, green
 * merges, a red that outlasts the fixes or a timeout fails without
 * merging (a timeout gets no fix agent).
 */

import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { nullReporter, runPipeline } from '@funny/pipelines';

import { loadWorkflowCatalog } from '../catalog.js';
import type { ActionProvider, ActionResult } from '../compiler/action-provider.js';
import { compileYamlPipeline } from '../compiler/yaml-compiler.js';
import { resolvePromptFiles } from '../prompt-files.js';

const ok: ActionResult = { ok: true, output: '' };

/** A built-in flow as the factory runs it: its prompt files read from beside it. */
async function resolvedBuiltIn(name: string) {
  const { workflows } = await loadWorkflowCatalog();
  const entry = workflows.get(name)!;
  const resolved = await resolvePromptFiles(entry.workflow, (path) =>
    readFile(join(dirname(entry.filePath), path), 'utf8').catch(() => null),
  );
  if (!resolved.ok) throw new Error(JSON.stringify(resolved.problems));
  return resolved.workflow;
}

/** Triage that wrote a contract, as the factory's provider reports it. */
const CONTRACT = 'Acceptance criteria:\n- Negative numbers are summed';
const triaged: ActionResult = {
  ok: true,
  output: 'ready',
  metadata: { decision: 'ready', contract: CONTRACT },
};

/** A review verdict as the factory's provider reports it. */
const verdict = (allowsMerge: boolean, feedback = ''): ActionResult => ({
  ok: true,
  output: allowsMerge ? 'pass' : 'fail',
  metadata: {
    verdict: allowsMerge ? 'pass' : 'fail',
    allowsMerge,
    blocking: !allowsMerge,
    sha: 'abc123',
    feedback,
  },
});
const pass = verdict(true);

/** An integrate step as the factory's provider reports it. */
const integrated = (outcome: string, feedback = ''): ActionResult => ({
  ok: true,
  output: outcome,
  metadata: { outcome, conflict: outcome === 'conflict', feedback },
});
const upToDate = integrated('up-to-date');

/**
 * A provider whose `wait_ci` answers from `ci` and whose `review` answers from
 * `reviews`, each in order (the last repeats).
 */
function provider(
  ci: ActionResult[],
  reviews: ActionResult[] = [pass],
  mergeResults: ActionResult[] = [ok],
  integrations: ActionResult[] = [upToDate],
) {
  const prompts: string[] = [];
  let looks = 0;
  let merges = 0;
  let integrates = 0;
  let reviewed = 0;
  const waits: Array<{ earlyReview?: unknown }> = [];
  const p: ActionProvider = {
    spawnAgent: async (opts) => {
      prompts.push(opts.prompt);
      return ok;
    },
    runCommand: async () => ok,
    gitCommit: async () => ok,
    gitPush: async () => ok,
    createPr: async () => ok,
    notify: async () => ok,
    setStatus: async () => ok,
    setStage: async () => ok,
    regressionProof: async () => ok,
    triage: async () => triaged,
    review: async () => reviews[Math.min(reviewed++, reviews.length - 1)]!,
    waitCi: async (opts) => {
      waits.push(opts);
      return ci[Math.min(looks++, ci.length - 1)]!;
    },
    merge: async () => mergeResults[Math.min(merges++, mergeResults.length - 1)]!,
    integrate: async () => integrations[Math.min(integrates++, integrations.length - 1)]!,
    requestApproval: async () => ({ decision: 'approve' }),
  };
  return {
    p,
    prompts,
    merges: () => merges,
    looks: () => looks,
    reviews: () => reviewed,
    integrates: () => integrates,
    waits,
  };
}

const red: ActionResult = { ok: false, error: 'Failing checks: test\n\n--- test ---\nboom' };
const green: ActionResult = { ok: true, output: 'green' };
const timeout: ActionResult = { ok: false, error: 'The checks did not finish within 3600 s.' };

async function run(
  ci: ActionResult[],
  flow = 'issue-to-merge',
  reviews?: ActionResult[],
  mergeResults?: ActionResult[],
  integrations?: ActionResult[],
) {
  const pipeline = compileYamlPipeline(await resolvedBuiltIn(flow));
  const fake = provider(ci, reviews, mergeResults, integrations);
  const result = await runPipeline(pipeline, {
    provider: fake.p,
    progress: nullReporter,
    cwd: '',
    inputs: {
      repo: 'o/r',
      issue_number: '7',
      issue_title: 'Fix it',
      issue_url: 'u/7',
      branch: 'factory/issue-7',
    },
    outputs: {},
  });
  return { ...fake, outcome: result.outcome, error: result.error };
}

// openspec factory-flow-step-options, 5.2: the agent forgot to open the pull request.
describe('a missing pull request', () => {
  const noPr: ActionResult = {
    ok: false,
    error: 'No open pull request from the branch factory/issue-7: the agent did not open one.',
  };

  async function runWithPrs(name: string, prs: ActionResult[]) {
    const fake = provider([green]);
    let looks = 0;
    const steps: Array<string | undefined> = [];
    const spawn = fake.p.spawnAgent;
    fake.p.spawnAgent = async (opts) => {
      steps.push(opts.stepId);
      return spawn(opts);
    };
    fake.p.createPr = async () => prs[Math.min(looks++, prs.length - 1)]!;
    const result = await runPipeline(compileYamlPipeline(await resolvedBuiltIn(name)), {
      provider: fake.p,
      progress: nullReporter,
      cwd: '',
      inputs: {
        repo: 'o/r',
        issue_number: '7',
        issue_title: 'Fix it',
        issue_url: 'u/7',
        branch: 'factory/issue-7',
      },
      outputs: {},
    });
    return { result, steps, prompts: fake.prompts, looks: () => looks };
  }

  test.each(['issue-to-pr', 'issue-to-merge'])(
    '%s asks the agent once to open it, then goes on',
    async (name) => {
      const { result, steps, prompts, looks } = await runWithPrs(name, [noPr, ok]);
      expect(looks()).toBe(2);
      expect(steps).toContain('pull-request.before_retry');
      const ask = prompts[steps.indexOf('pull-request.before_retry')]!;
      expect(ask).toContain('there is no\nopen pull request from the branch `factory/issue-7`');
      expect(ask).toContain('did not open one');
      expect(result.outcome).toBe('completed');
    },
  );

  test('still none after asking: the run fails with the same reason', async () => {
    const { result, looks } = await runWithPrs('issue-to-pr', [noPr]);
    expect(looks()).toBe(2);
    expect(result.outcome).not.toBe('completed');
    expect(String(result.error)).toContain('did not open one');
  });
});

describe('issue-to-merge workflow', () => {
  test('is a built-in beside issue-to-pr, and both compile', async () => {
    const { workflows, warnings } = await loadWorkflowCatalog();
    // The only catalog warnings are the proof-not-configured ones from built-in flows
    // (they ship without rules as templates).
    const unexpected = warnings.filter((w) => !w.includes('no rules'));
    expect(unexpected).toEqual([]);
    for (const name of ['issue-to-merge', 'issue-to-pr']) {
      expect(workflows.get(name)?.source).toBe('built-in');
      expect(() => compileYamlPipeline(workflows.get(name)!.workflow)).not.toThrow();
    }
  });

  test('issue-to-pr stops at the pull request: no CI wait, no merge', async () => {
    const r = await run([green], 'issue-to-pr');
    expect(r.outcome).toBe('completed');
    expect(r.prompts).toHaveLength(1);
    expect(r.looks()).toBe(0);
    expect(r.merges()).toBe(0);
  });

  test('green CI merges after the one implement agent', async () => {
    const r = await run([green]);
    expect(r.outcome).toBe('completed');
    expect(r.prompts).toHaveLength(1);
    expect(r.merges()).toBe(1);
  });

  test('red → fix → green merges, and the fix agent gets the failing log', async () => {
    const r = await run([red, green]);
    expect(r.outcome).toBe('completed');
    expect(r.prompts).toHaveLength(2);
    expect(r.prompts[1]).toContain('boom');
    expect(r.prompts[1]).toContain('push to `factory/issue-7`');
    expect(r.merges()).toBe(1);
  });

  test('red after every fix fails the run and never merges', async () => {
    const r = await run([red]);
    expect(r.outcome).toBe('failed');
    expect(r.looks()).toBe(3);
    expect(r.prompts).toHaveLength(3);
    expect(r.merges()).toBe(0);
  });

  test('a CI timeout fails at once, without a fix agent', async () => {
    const r = await run([timeout]);
    expect(r.outcome).toBe('failed');
    expect(r.looks()).toBe(1);
    expect(r.prompts).toHaveLength(1);
    expect(r.merges()).toBe(0);
  });

  // Change factory-agent-roles: the review gate and its loop back to the implementer.
  describe('review loop', () => {
    const findings = '- [high] src/sum.ts:3: negative numbers are dropped';
    const fail = verdict(false, findings);

    test('a passing review merges after one review, and no address turn runs', async () => {
      const r = await run([green]);
      expect(r.outcome).toBe('completed');
      expect(r.reviews()).toBe(1);
      expect(r.prompts).toHaveLength(1);
      expect(r.merges()).toBe(1);
    });

    test('fail → address → pass: the implementer gets the findings and the commit is reviewed again', async () => {
      const r = await run([green], 'issue-to-merge', [fail, pass]);
      expect(r.outcome).toBe('completed');
      expect(r.reviews()).toBe(2);
      // The checks ran again on the new commit before the second review.
      expect(r.looks()).toBe(2);
      expect(r.prompts).toHaveLength(2);
      expect(r.prompts[1]).toContain(findings);
      expect(r.prompts[1]).toContain('commit abc123');
      expect(r.prompts[1]).toContain('Do not rebase or force push');
      expect(r.merges()).toBe(1);
    });

    test('a review that fails every round ends the run without a merge', async () => {
      const r = await run([green], 'issue-to-merge', [fail]);
      expect(r.outcome).toBe('failed');
      expect(r.error).toContain('loop exhausted');
      expect(r.reviews()).toBe(3);
      // Two correction rounds: the implement turn and two address turns.
      expect(r.prompts).toHaveLength(3);
      expect(r.merges()).toBe(0);
    });

    test('a review without a verdict stops the run: nothing is merged', async () => {
      const r = await run([green], 'issue-to-merge', [
        { ok: false, error: 'The review gave no verdict.' },
      ]);
      expect(r.outcome).toBe('failed');
      expect(r.reviews()).toBe(1);
      expect(r.merges()).toBe(0);
    });

    test('the checks are told about the review, so it can start with them', async () => {
      const r = await run([green]);
      expect(r.waits[0]?.earlyReview).toEqual({ early: true });
    });

    test('a flow whose review sets early: false tells the checks nothing', async () => {
      const builtIn = await resolvedBuiltIn('issue-to-merge');
      const late = {
        ...builtIn,
        nodes: builtIn.nodes.map((node) =>
          node.review ? { ...node, review: { ...node.review, early: false } } : node,
        ),
      };
      const fake = provider([green]);
      await runPipeline(compileYamlPipeline(late), {
        provider: fake.p,
        progress: nullReporter,
        cwd: '',
        inputs: {
          repo: 'o/r',
          issue_number: '7',
          issue_title: 'Fix it',
          issue_url: 'u/7',
          branch: 'b',
        },
        outputs: {},
      });
      expect(fake.waits[0]?.earlyReview).toBeUndefined();
      expect(fake.reviews()).toBe(1);
    });

    test('issue-to-pr has no review step', async () => {
      const r = await run([green], 'issue-to-pr');
      expect(r.reviews()).toBe(0);
    });
  });

  // Change factory-agent-roles, D8/D9, and factory-integration 3.4: a round
  // `merge` sends back starts again at `integrate`; only what it cannot settle,
  // or checks that fail on the new base, reach the implementer.
  describe('merge loop', () => {
    const conflict = 'The pull request from `factory/issue-7` conflicts with `main`';
    const sentBack = (why: 'conflict' | 'checks', feedback = conflict): ActionResult => ({
      ok: true,
      output: 'sent_back',
      metadata: { outcome: 'sent_back', why, feedback },
    });
    const merged: ActionResult = { ok: true, output: 'merged', metadata: { outcome: 'merged' } };
    const realConflict = integrated(
      'conflict',
      'Merging the base branch main into this branch left conflicts that could not be settled without you, in:\n- src/sum.ts',
    );

    test('integrate runs before the checks, and a branch with its base goes straight on', async () => {
      const r = await run([green]);
      expect(r.outcome).toBe('completed');
      expect(r.integrates()).toBe(1);
      expect(r.prompts).toHaveLength(1);
    });

    test('a conflict integrate settles never reaches the implementer', async () => {
      const r = await run(
        [green],
        'issue-to-merge',
        [pass],
        [sentBack('conflict'), merged],
        [upToDate, integrated('merged')],
      );
      expect(r.outcome).toBe('completed');
      expect(r.merges()).toBe(2);
      expect(r.integrates()).toBe(2);
      // Only the implement turn: no address.
      expect(r.prompts).toHaveLength(1);
      // The merged commit went through the checks and the review again.
      expect(r.looks()).toBe(2);
      expect(r.reviews()).toBe(2);
    });

    test('a conflict integrate cannot settle goes to the implementer with its paths', async () => {
      const r = await run(
        [green],
        'issue-to-merge',
        [pass],
        [sentBack('conflict'), merged],
        [upToDate, realConflict, upToDate],
      );
      expect(r.outcome).toBe('completed');
      expect(r.prompts).toHaveLength(2);
      expect(r.prompts[1]).toContain('- src/sum.ts');
      expect(r.prompts[1]).not.toContain('An independent review');
      expect(r.prompts[1]).not.toContain('passed its review but cannot merge yet');
      expect(r.prompts[1]).toContain('Do not rebase or force push');
    });

    test('a conflict on the first integration goes to the implementer before the checks', async () => {
      const r = await run([green], 'issue-to-merge', [pass], [merged], [realConflict, upToDate]);
      expect(r.outcome).toBe('completed');
      expect(r.prompts).toHaveLength(2);
      expect(r.prompts[1]).toContain('- src/sum.ts');
      expect(r.looks()).toBe(1);
    });

    test('checks that fail on the new base go to the implementer', async () => {
      const failing = 'The checks fail on the current base: test';
      const r = await run([green], 'issue-to-merge', [pass], [sentBack('checks', failing), merged]);
      expect(r.outcome).toBe('completed');
      expect(r.prompts).toHaveLength(2);
      expect(r.prompts[1]).toContain(failing);
      expect(r.prompts[1]).toContain('passed its review but cannot merge yet');
      expect(r.looks()).toBe(2);
      expect(r.reviews()).toBe(2);
    });

    test('a review that fails after a fix sends its own findings, not the merge feedback', async () => {
      const findings = '- [high] src/sum.ts:3: the merge dropped a case';
      const r = await run(
        [green],
        'issue-to-merge',
        [pass, verdict(false, findings), pass],
        [sentBack('checks'), merged],
      );
      expect(r.outcome).toBe('completed');
      expect(r.prompts).toHaveLength(3);
      expect(r.prompts[2]).toContain(findings);
      expect(r.prompts[2]).not.toContain(conflict);
    });

    test('four rounds settled by integrate do not end the run', async () => {
      const r = await run(
        [green],
        'issue-to-merge',
        [pass],
        [
          sentBack('conflict'),
          sentBack('conflict'),
          sentBack('conflict'),
          sentBack('conflict'),
          merged,
        ],
        [upToDate, integrated('merged')],
      );
      expect(r.outcome).toBe('completed');
      expect(r.merges()).toBe(5);
      expect(r.prompts).toHaveLength(1);
    });

    test('a branch sent back every time ends the run after 10 merge rounds', async () => {
      const r = await run([green], 'issue-to-merge', [pass], [sentBack('conflict')]);
      expect(r.outcome).toBe('failed');
      expect(r.error).toContain('loop exhausted');
      expect(r.merges()).toBe(10);
    });

    test('a provider whose merge reports no outcome ends the loop after one merge', async () => {
      const r = await run([green]);
      expect(r.outcome).toBe('completed');
      expect(r.merges()).toBe(1);
    });
  });

  // Change factory-agent-roles, phase 2: triage comes first in both built-ins.
  describe('triage', () => {
    test('the implementing agent gets the contract triage wrote', async () => {
      for (const flow of ['issue-to-merge', 'issue-to-pr']) {
        const r = await run([green], flow);
        expect(r.outcome).toBe('completed');
        expect(r.prompts[0]).toContain('Your change must meet this contract');
        expect(r.prompts[0]).toContain(CONTRACT);
      }
    });

    test('a run without a contract gets no contract section', async () => {
      await loadWorkflowCatalog();
      const fake = provider([green]);
      fake.p.triage = async () => ({
        ok: true,
        output: 'none',
        metadata: { decision: 'none', contract: '' },
      });
      const result = await runPipeline(compileYamlPipeline(await resolvedBuiltIn('issue-to-pr')), {
        provider: fake.p,
        progress: nullReporter,
        cwd: '',
        inputs: {
          repo: 'o/r',
          issue_number: '7',
          issue_title: 'Fix it',
          issue_url: 'u/7',
          branch: 'b',
        },
        outputs: {},
      });
      expect(result.outcome).toBe('completed');
      expect(fake.prompts[0]).not.toContain('contract');
      expect(fake.prompts[0]).toContain('Read the issue first: u/7');
    });

    test('triage that stops the run starts no implementing agent', async () => {
      await loadWorkflowCatalog();
      const fake = provider([green]);
      fake.p.triage = async () => ({ ok: false, error: 'The issue needs more information: ?' });
      const result = await runPipeline(
        compileYamlPipeline(await resolvedBuiltIn('issue-to-merge')),
        {
          provider: fake.p,
          progress: nullReporter,
          cwd: '',
          inputs: {
            repo: 'o/r',
            issue_number: '7',
            issue_title: 'Fix it',
            issue_url: 'u/7',
            branch: 'b',
          },
          outputs: {},
        },
      );
      expect(result.outcome).toBe('failed');
      expect(fake.prompts).toEqual([]);
      expect(fake.merges()).toBe(0);
    });
  });
});

// #441: `{{files}}` in a proof rule is the runtime's placeholder; the flow's
// interpolation rendered it as '' and every rule ran its whole suite.
describe('regression proof rules', () => {
  test('keep {{files}} in the commands the proof and merge steps receive', async () => {
    const workflow = await resolvedBuiltIn('issue-to-merge');
    const proofNode = workflow.nodes.find((n) => n.regression_proof !== undefined)!;
    proofNode.regression_proof = {
      ...proofNode.regression_proof!,
      rules: [
        {
          globs: ['packages/client/**/*.test.ts'],
          cwd: 'packages/client',
          command: 'bun test --parallel {{files}}',
        },
        { globs: ['**/*.test.ts'], command: 'bun test {{files}}' },
      ],
    };
    const fake = provider([green]);
    const received: string[][] = [];
    fake.p.regressionProof = async (opts) => {
      received.push(opts.rules.map((r) => r.command));
      return ok;
    };
    const merge = fake.p.merge;
    fake.p.merge = async (opts) => {
      received.push((opts.regressionProof?.rules ?? []).map((r) => r.command));
      return merge(opts);
    };
    await runPipeline(compileYamlPipeline(workflow), {
      provider: fake.p,
      progress: nullReporter,
      cwd: '',
      inputs: {
        repo: 'o/r',
        issue_number: '7',
        issue_title: 'Fix it',
        issue_url: 'u/7',
        branch: 'factory/issue-7',
      },
      outputs: {},
    });
    expect(received.length).toBeGreaterThanOrEqual(2);
    for (const commands of received) {
      expect(commands).toEqual(['bun test --parallel {{files}}', 'bun test {{files}}']);
    }
  });
});
