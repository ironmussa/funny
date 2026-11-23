/**
 * funny's own `.funny/workflows/issue-to-merge.yaml` (task 5.3 of
 * factory-quality-gates): it must parse, be proof-ready, and stay in step
 * with the built-in it replaces.
 */

import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';

import { parseWorkflowYaml } from '../parse.js';
import { isProofReady } from '../schema.js';

const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), 'utf8');

function parsed(relative: string) {
  const result = parseWorkflowYaml(read(relative), relative);
  if (!result.ok) throw new Error(result.error.message);
  return result.workflow;
}

describe("funny's issue-to-merge flow", () => {
  const repo = parsed('../../../../.funny/workflows/issue-to-merge.yaml');
  const builtIn = parsed('../../defaults/issue-to-merge.yaml');

  test('is proof-ready, so the factory admits its issues', () => {
    expect(isProofReady(repo)).toBe(true);
  });

  test('has the steps of the built-in, in the same order', () => {
    expect(repo.nodes.map((n) => n.id)).toEqual(builtIn.nodes.map((n) => n.id));
  });

  test('differs from the built-in only in its proof rules', () => {
    const withoutRules = (workflow: typeof repo) =>
      workflow.nodes.map((node) =>
        node.regression_proof
          ? { ...node, regression_proof: { ...node.regression_proof, rules: [] } }
          : node,
      );
    expect(withoutRules(repo)).toEqual(withoutRules(builtIn));
  });

  test("keeps the built-in's prompt files, since a repository flow reads its own", () => {
    const names = readdirSync(new URL('../../defaults/prompts/', import.meta.url));
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      expect(read(`../../../../.funny/workflows/prompts/${name}`)).toBe(
        read(`../../defaults/prompts/${name}`),
      );
    }
  });

  test('routes each package to its own test command, the rest to the root', () => {
    const rules = repo.nodes.find((n) => n.regression_proof)!.regression_proof!.rules;
    const ruleFor = (file: string) =>
      rules.find((rule) => rule.globs.some((glob) => new Bun.Glob(glob).match(file)));
    expect(ruleFor('packages/client/src/__tests__/components/PromptInput.test.tsx')?.cwd).toBe(
      'packages/client',
    );
    expect(ruleFor('packages/server/src/__tests__/x.test.ts')?.command).toContain('--isolate');
    expect(ruleFor('packages/shared/src/__tests__/x.test.ts')?.cwd).toBeUndefined();
    expect(ruleFor('e2e/accessibility.spec.ts')).toBeUndefined();
  });
});
