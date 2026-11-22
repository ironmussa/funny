/**
 * The server factory's flows: `issue-to-merge` (the default) and
 * `issue-to-pr`, built-ins that compile beside `factory-issue`, and the CI fix
 * loop of `issue-to-merge` — red runs a fix agent with the failing log, green
 * merges, a red that outlasts the fixes or a timeout fails without
 * merging (a timeout gets no fix agent).
 */

import { describe, expect, test } from 'bun:test';

import { nullReporter, runPipeline } from '@funny/pipelines';

import { loadWorkflowCatalog } from '../catalog.js';
import type { ActionProvider, ActionResult } from '../compiler/action-provider.js';
import { compileYamlPipeline } from '../compiler/yaml-compiler.js';

const ok: ActionResult = { ok: true, output: '' };

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

/**
 * A provider whose `wait_ci` answers from `ci` and whose `review` answers from
 * `reviews`, each in order (the last repeats).
 */
function provider(
  ci: ActionResult[],
  reviews: ActionResult[] = [pass],
  mergeResults: ActionResult[] = [ok],
) {
  const prompts: string[] = [];
  let looks = 0;
  let merges = 0;
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
    review: async () => reviews[Math.min(reviewed++, reviews.length - 1)]!,
    waitCi: async (opts) => {
      waits.push(opts);
      return ci[Math.min(looks++, ci.length - 1)]!;
    },
    merge: async () => mergeResults[Math.min(merges++, mergeResults.length - 1)]!,
    requestApproval: async () => ({ decision: 'approve' }),
  };
  return { p, prompts, merges: () => merges, looks: () => looks, reviews: () => reviewed, waits };
}

const red: ActionResult = { ok: false, error: 'Failing checks: test\n\n--- test ---\nboom' };
const green: ActionResult = { ok: true, output: 'green' };
const timeout: ActionResult = { ok: false, error: 'The checks did not finish within 3600 s.' };

async function run(
  ci: ActionResult[],
  flow = 'issue-to-merge',
  reviews?: ActionResult[],
  mergeResults?: ActionResult[],
) {
  const { workflows } = await loadWorkflowCatalog();
  const pipeline = compileYamlPipeline(workflows.get(flow)!.workflow);
  const fake = provider(ci, reviews, mergeResults);
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

describe('issue-to-merge workflow', () => {
  test('is a built-in beside factory-issue, and both compile', async () => {
    const { workflows, warnings } = await loadWorkflowCatalog();
    // The only catalog warnings are the proof-not-configured ones from built-in flows
    // (they ship without rules as templates).
    const unexpected = warnings.filter((w) => !w.includes('no rules'));
    expect(unexpected).toEqual([]);
    for (const name of ['issue-to-merge', 'issue-to-pr', 'factory-issue']) {
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
      const { workflows } = await loadWorkflowCatalog();
      const builtIn = workflows.get('issue-to-merge')!.workflow;
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

  // Change factory-agent-roles, D8/D9: `merge` sends a conflict back to the implementer.
  describe('merge loop', () => {
    const conflict = 'The pull request from `factory/issue-7` conflicts with `main`';
    const sentBack: ActionResult = {
      ok: true,
      output: 'sent_back',
      metadata: { outcome: 'sent_back', why: 'conflict', feedback: conflict },
    };
    const merged: ActionResult = { ok: true, output: 'merged', metadata: { outcome: 'merged' } };

    test('a conflict goes to the implementer, then the checks and the review run again before the merge', async () => {
      const r = await run([green], 'issue-to-merge', [pass], [sentBack, merged]);
      expect(r.outcome).toBe('completed');
      expect(r.merges()).toBe(2);
      // The implement turn, then the conflict as a follow-up: not the review's wording.
      expect(r.prompts).toHaveLength(2);
      expect(r.prompts[1]).toContain(conflict);
      expect(r.prompts[1]).toContain('passed its review but cannot merge yet');
      expect(r.prompts[1]).not.toContain('An independent review');
      expect(r.prompts[1]).toContain('Do not rebase or force push');
      // The new commit went through the checks and the review again.
      expect(r.looks()).toBe(2);
      expect(r.reviews()).toBe(2);
    });

    test('a review that fails after a conflict fix sends its own findings, not the conflict again', async () => {
      const findings = '- [high] src/sum.ts:3: the merge dropped a case';
      const r = await run(
        [green],
        'issue-to-merge',
        [pass, verdict(false, findings), pass],
        [sentBack, merged],
      );
      expect(r.outcome).toBe('completed');
      expect(r.prompts).toHaveLength(3);
      expect(r.prompts[2]).toContain(findings);
      expect(r.prompts[2]).not.toContain(conflict);
    });

    test('a branch that conflicts every time ends the run without a merge', async () => {
      const r = await run([green], 'issue-to-merge', [pass], [sentBack]);
      expect(r.outcome).toBe('failed');
      expect(r.error).toContain('loop exhausted');
      expect(r.merges()).toBe(3);
    });

    test('a provider whose merge reports no outcome ends the loop after one merge', async () => {
      const r = await run([green]);
      expect(r.outcome).toBe('completed');
      expect(r.merges()).toBe(1);
    });
  });
});
