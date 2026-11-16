/**
 * The server factory's default flow: a built-in that compiles beside
 * `factory-issue`, and its CI fix loop — red runs a fix agent with the failing
 * log, green merges, a red that outlasts the fixes or a timeout fails without
 * merging (a timeout gets no fix agent).
 */

import { nullReporter, runPipeline } from '@funny/pipelines';
import { describe, expect, test } from 'vitest';

import { loadWorkflowCatalog } from '../catalog.js';
import type { ActionProvider, ActionResult } from '../compiler/action-provider.js';
import { compileYamlPipeline } from '../compiler/yaml-compiler.js';

const ok: ActionResult = { ok: true, output: '' };

/** A provider whose `wait_ci` answers from `ci` in order (the last repeats). */
function provider(ci: ActionResult[]) {
  const prompts: string[] = [];
  let looks = 0;
  let merges = 0;
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
    waitCi: async () => ci[Math.min(looks++, ci.length - 1)]!,
    merge: async () => {
      merges++;
      return ok;
    },
    requestApproval: async () => ({ decision: 'approve' }),
  };
  return { p, prompts, merges: () => merges, looks: () => looks };
}

const red: ActionResult = { ok: false, error: 'Failing checks: test\n\n--- test ---\nboom' };
const green: ActionResult = { ok: true, output: 'green' };
const timeout: ActionResult = { ok: false, error: 'The checks did not finish within 3600 s.' };

async function run(ci: ActionResult[]) {
  const { workflows } = await loadWorkflowCatalog();
  const pipeline = compileYamlPipeline(workflows.get('issue-to-merge')!.workflow);
  const fake = provider(ci);
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
  return { ...fake, outcome: result.outcome };
}

describe('issue-to-merge workflow', () => {
  test('is a built-in beside factory-issue, and both compile', async () => {
    const { workflows, warnings } = await loadWorkflowCatalog();
    expect(warnings).toEqual([]);
    for (const name of ['issue-to-merge', 'factory-issue']) {
      expect(workflows.get(name)?.source).toBe('built-in');
      expect(() => compileYamlPipeline(workflows.get(name)!.workflow)).not.toThrow();
    }
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
});
