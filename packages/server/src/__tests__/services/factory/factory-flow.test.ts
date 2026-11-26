/**
 * Loading a factory flow with the factory's host rule (change
 * workflow-dag-engine, task 3.6): two agent steps continue the run's one
 * thread, so they cannot be in parallel branches.
 */
import { describe, expect, test } from 'bun:test';

import { ok } from 'neverthrow';

import { admissionPriority } from '../../../services/factory/factory-flow-runs.js';
import {
  isMergeLane,
  loadFactoryFlow,
  readFactoryFlowDefinition,
  reviewerSameAsImplementer,
} from '../../../services/factory/factory-flow.js';

function fromRepository(yaml: string) {
  return {
    readDefaultBranchFile: async (path: string) =>
      ok(path === '.funny/workflows/custom.yaml' ? yaml : null),
  };
}

const HEADER = `name: custom
description: test flow
nodes:
`;

async function load(nodes: string) {
  return loadFactoryFlow('custom', fromRepository(HEADER + nodes));
}

describe('factory flow host validation', () => {
  test('two agent steps in parallel branches are refused, naming both', async () => {
    const flow = await load(`  - id: plan
    spawn_agent: { prompt: plan }
  - id: review-a
    depends_on: [plan]
    spawn_agent: { prompt: a }
  - id: review-b
    depends_on: [plan]
    spawn_agent: { prompt: b }
`);
    expect(flow.isErr()).toBe(true);
    const error = flow._unsafeUnwrapErr();
    expect(error.kind).toBe('invalid');
    expect(error.message).toContain('not allowed here');
    expect(error.message).toContain('"review-a" and "review-b"');
    expect(error.message).not.toContain('"plan"');
  });

  test('two root agent steps run at once and are refused', async () => {
    const flow = await load(`  - id: one
    spawn_agent: { prompt: one }
  - id: two
    spawn_agent: { prompt: two }
`);
    expect(flow._unsafeUnwrapErr().message).toContain('"one" and "two"');
  });

  test('a fixer agent (before_retry) counts as an agent step', async () => {
    const flow = await load(`  - id: implement
    spawn_agent: { prompt: implement }
  - id: pull-request
    depends_on: [implement]
    create_pr: { title: t }
  - id: ci
    depends_on: [pull-request]
    wait_ci: {}
    on_error: retry
    retry:
      max_attempts: 2
      before_retry: { prompt: fix }
  - id: docs
    depends_on: [implement]
    spawn_agent: { prompt: docs }
`);
    expect(flow._unsafeUnwrapErr().message).toContain('"ci" and "docs"');
  });

  test('agent steps ordered through other steps, beside parallel non-agent steps, load', async () => {
    const flow = await load(`  - id: implement
    spawn_agent: { prompt: implement }
  - id: pull-request
    depends_on: [implement]
    create_pr: { title: t }
  - id: ci
    depends_on: [pull-request]
    wait_ci: {}
  - id: notify
    depends_on: [pull-request]
    notify: { message: opened }
  - id: polish
    depends_on: [ci, notify]
    spawn_agent: { prompt: polish }
`);
    expect(flow.isOk()).toBe(true);
  });

  // Change factory-agent-roles: the reviewer cannot be given write access by a flow.
  test('a review step with a write permission mode is refused, naming the step and the field', async () => {
    const flow = await load(`  - id: implement
    spawn_agent: { prompt: do it }
  - id: second-opinion
    depends_on: [implement]
    review: { permission_mode: autoEdit }
`);
    expect(flow.isErr()).toBe(true);
    const error = flow._unsafeUnwrapErr();
    expect(error.kind).toBe('invalid');
    expect(error.message).toContain('second-opinion');
    expect(error.message).toContain('permission_mode');
  });

  test('a review step beside the implementing agent loads: it has its own thread', async () => {
    const flow = await load(`  - id: implement
    spawn_agent: { prompt: do it }
  - id: second-opinion
    depends_on: [implement]
    review: { model: opus, early: false }
`);
    expect(flow.isOk()).toBe(true);
  });

  // Change factory-agent-roles, D8: the merge lane.
  describe('the merge lane', () => {
    const laneOf = async (mergeNode: string) => {
      const flow = await load(`  - id: implement
    spawn_agent: { prompt: do it }
  - id: land
    depends_on: [implement]
${mergeNode}
`);
      const node = flow._unsafeUnwrap().pipeline.nodes.find((n) => n.name === 'land');
      const group = node?.concurrency?.group;
      const inputs = { repo: 'o/r', base_branch: 'main' };
      return {
        // SAFETY: the group reads only the run's inputs.
        group: typeof group === 'function' ? group({ inputs } as never) : group,
        limit: node?.concurrency?.limit,
      };
    };

    test('a merge without a concurrency group gets the lane of its repository and base branch', async () => {
      expect(
        await laneOf('    merge: { require_review: false, require_regression_proof: false }'),
      ).toEqual({
        group: 'merge:o/r:main',
        limit: 1,
      });
    });

    test("a merge's own group and limit are replaced: no flow merges two at once", async () => {
      expect(
        await laneOf(`    concurrency: { group: "mine-{{inputs.repo}}", limit: 5 }
    merge: { require_review: false, require_regression_proof: false }`),
      ).toEqual({ group: 'merge:o/r:main', limit: 1 });
    });
  });

  test('the built-in factory flows pass the rule', async () => {
    for (const name of ['issue-to-merge', 'issue-to-pr']) {
      const flow = await loadFactoryFlow(name, { readDefaultBranchFile: async () => ok(null) });
      expect(flow.isOk()).toBe(true);
    }
  });
});

describe('factory flow warnings', () => {
  test('a repository flow with a parse warning loads and carries the warning', async () => {
    const flow = await load(`  - id: implement
    spawn_agent: { prompt: implement }
    on_error: continue
  - id: after
    depends_on: [implement]
    notify: { message: done }
`);
    expect(flow.isOk()).toBe(true);
    expect(flow._unsafeUnwrap().warnings).toEqual([
      expect.objectContaining({ path: 'nodes.1.trigger_rule' }),
    ]);
  });

  test('a repository copy that still asks for a new branch is warned about', async () => {
    const flow = await load(`  - id: implement
    spawn_agent: { prompt: "Work on a new branch named {{branch}}" }
  - id: pull-request
    depends_on: [implement]
    create_pr: { title: t }
  - id: ci
    depends_on: [pull-request]
    wait_ci: {}
    on_error: retry
    retry:
      max_attempts: 2
      before_retry: { prompt: "Push the fix to a New Branch" }
`);
    const stale = flow._unsafeUnwrap().warnings.filter((w) => w.message.includes('new branch'));
    expect(stale.map((w) => w.path)).toEqual([
      'nodes.0.spawn_agent.prompt',
      'nodes.2.retry.before_retry.prompt',
    ]);
  });

  test('the current branch wording is not warned about', async () => {
    const flow = await load(`  - id: implement
    spawn_agent: { prompt: "Work on the branch {{branch}}. You may already be on it." }
`);
    expect(flow._unsafeUnwrap().warnings).toEqual([]);
  });

  test('with the Spec stage on, a flow whose implementer ignores {{spec}} is warned about', async () => {
    const yaml = `${HEADER}  - id: implement
    spawn_agent: { prompt: "Implement {{issue_number}}" }
`;
    const flow = await loadFactoryFlow('custom', fromRepository(yaml), { specStage: true });
    expect(flow._unsafeUnwrap().warnings).toEqual([
      expect.objectContaining({ path: 'nodes.0.spawn_agent.prompt' }),
    ]);
    const off = await loadFactoryFlow('custom', fromRepository(yaml), { specStage: false });
    expect(off._unsafeUnwrap().warnings).toEqual([]);
  });

  test('a flow whose implementer uses {{spec}} is not warned about', async () => {
    const yaml = `${HEADER}  - id: implement
    spawn_agent: { prompt: "Implement it. {{#spec}}Follow {{spec}}{{/spec}}" }
`;
    const flow = await loadFactoryFlow('custom', fromRepository(yaml), { specStage: true });
    expect(flow._unsafeUnwrap().warnings).toEqual([]);
  });

  test('the built-in factory flows have only the proof-not-configured warning', async () => {
    for (const name of ['issue-to-merge', 'issue-to-pr']) {
      const flow = await loadFactoryFlow(name, { readDefaultBranchFile: async () => ok(null) });
      const unexpected = flow
        ._unsafeUnwrap()
        .warnings.filter((w) => !w.message.includes('no rules'));
      expect(unexpected).toEqual([]);
    }
  });
});

describe('reading a factory flow definition', () => {
  test('the repository copy wins and is returned without compiling', async () => {
    // Invalid as a flow (no nodes), but still readable: the viewer shows it.
    const yaml = 'name: custom\ndescription: broken\n';
    const read = await readFactoryFlowDefinition('custom', fromRepository(yaml));
    expect(read._unsafeUnwrap()).toEqual({
      name: 'custom',
      source: 'repository',
      path: '.funny/workflows/custom.yaml',
      yaml,
    });
  });

  test('a built-in is returned without its server path', async () => {
    const read = await readFactoryFlowDefinition('issue-to-merge', {
      readDefaultBranchFile: async () => ok(null),
    });
    const definition = read._unsafeUnwrap();
    expect(definition.source).toBe('built-in');
    expect(definition.path).toBeNull();
    expect(definition.yaml).toContain('nodes');
  });

  test('an unknown flow is refused', async () => {
    const read = await readFactoryFlowDefinition('nope', {
      readDefaultBranchFile: async () => ok(null),
    });
    expect(read._unsafeUnwrapErr().kind).toBe('invalid');
  });
});

describe('who gets a slot first', () => {
  test('the lane is recognized by its group, so its limit can be pinned', () => {
    expect(isMergeLane('merge:o/r:main')).toBe(true);
    expect(isMergeLane('review:factory-1')).toBe(false);
  });

  test('a run admitted earlier goes first, and the number fits a 32-bit column', () => {
    const earlier = admissionPriority({ admittedAt: '2026-11-22T10:00:00.000Z', startedAt: '' });
    const later = admissionPriority({ admittedAt: '2026-11-22T10:00:05.000Z', startedAt: '' });
    expect(earlier).toBeLessThan(later);
    expect(later - earlier).toBe(5);
    expect(
      admissionPriority({ admittedAt: '2090-01-01T00:00:00.000Z', startedAt: '' }),
    ).toBeLessThan(2 ** 31);
  });

  test('a run from before admissions were recorded uses when it started', () => {
    expect(admissionPriority({ admittedAt: null, startedAt: '2026-11-22T10:00:00.000Z' })).toBe(
      admissionPriority({ admittedAt: '2026-11-22T10:00:00.000Z', startedAt: '' }),
    );
  });
});

// Change factory-agent-roles: the settings warn when the reviewer is the implementer's model.
describe('whether the reviewer is the implementer model', () => {
  const flow = (implement: string, review: string | null, defaults = '') => `name: custom
${defaults}nodes:
  - id: implement
    spawn_agent: { prompt: do it${implement} }
${review === null ? '' : `  - id: second-opinion\n    depends_on: [implement]\n    review: ${review}\n`}`;
  const same = (yaml: string) => reviewerSameAsImplementer(yaml, 'custom.yaml');

  test('both left to the default are the same', () => {
    expect(same(flow('', '{}'))).toBe(true);
  });

  test('a review with its own model, or its own provider, is different', () => {
    expect(same(flow('', '{ model: opus }'))).toBe(false);
    expect(same(flow(', model: sonnet', '{ provider: codex, model: sonnet }'))).toBe(false);
  });

  test('the same model named on both is the same', () => {
    expect(same(flow(', model: sonnet', '{ model: sonnet }'))).toBe(true);
  });

  test("the flow's defaults count for a step that names nothing", () => {
    const defaults = 'defaults: { model: sonnet }\n';
    expect(same(flow('', '{}', defaults))).toBe(true);
    expect(same(flow('', '{ model: opus }', defaults))).toBe(false);
    expect(same(flow(', model: sonnet', '{}', defaults))).toBe(true);
  });

  test('a flow without a review step, or one that does not parse, says nothing', () => {
    expect(same(flow('', null))).toBeUndefined();
    expect(same('not: [a flow')).toBeUndefined();
  });

  test('the built-in flow is read with the answer', async () => {
    const read = await readFactoryFlowDefinition('issue-to-merge', {
      readDefaultBranchFile: async () => ok(null),
    });
    expect(read._unsafeUnwrap().reviewerSameAsImplementer).toBe(true);
    const pr = await readFactoryFlowDefinition('issue-to-pr', {
      readDefaultBranchFile: async () => ok(null),
    });
    expect(pr._unsafeUnwrap().reviewerSameAsImplementer).toBeUndefined();
  });
});
