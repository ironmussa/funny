/**
 * Loading a factory flow with the factory's host rule (change
 * workflow-dag-engine, task 3.6): two agent steps continue the run's one
 * thread, so they cannot be in parallel branches.
 */
import { describe, expect, test } from 'bun:test';

import { ok } from 'neverthrow';

import { loadFactoryFlow } from '../../../services/factory/factory-flow.js';

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

  test('the built-in factory flows have no warnings', async () => {
    for (const name of ['issue-to-merge', 'issue-to-pr']) {
      const flow = await loadFactoryFlow(name, { readDefaultBranchFile: async () => ok(null) });
      expect(flow._unsafeUnwrap().warnings).toEqual([]);
    }
  });
});
