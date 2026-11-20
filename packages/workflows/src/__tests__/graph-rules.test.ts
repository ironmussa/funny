/**
 * Schema fields and graph rules for the DAG engine: trigger_rule,
 * concurrency, several loops, and host validation.
 */
import { describe, expect, test } from 'vitest';

import { parseWorkflowYaml } from '../parse.js';

const notify = (message = 'x') => `notify: { message: ${message} }`;

function parse(nodes: string, options?: Parameters<typeof parseWorkflowYaml>[2]) {
  return parseWorkflowYaml(`name: t\nnodes:\n${nodes}`, 't.yaml', options);
}

function messages(result: ReturnType<typeof parse>): string[] {
  return result.ok ? [] : result.error.issues.map((i) => i.message);
}

describe('trigger_rule', () => {
  test.each(['all_success', 'all_done', 'one_success'])('accepts %s', (rule) => {
    const result = parse(`  - id: a\n    trigger_rule: ${rule}\n    ${notify()}\n`);
    expect(result.ok && result.workflow.nodes[0].trigger_rule).toBe(rule);
  });

  test('refuses an unknown rule', () => {
    expect(parse(`  - id: a\n    trigger_rule: any\n    ${notify()}\n`).ok).toBe(false);
  });
});

describe('concurrency', () => {
  test('accepts a group and a limit', () => {
    const result = parse(
      `  - id: merge\n    concurrency: { group: 'merge-{{repo}}', limit: 1 }\n    ${notify()}\n`,
    );
    expect(result.ok && result.workflow.nodes[0].concurrency).toEqual({
      group: 'merge-{{repo}}',
      limit: 1,
    });
  });

  test.each([
    ['60s', 60_000],
    ['500ms', 500],
    ['2m', 120_000],
    [1500, 1500],
  ])('reads a batch wait of %s as %d ms', (wait, ms) => {
    const result = parse(
      `  - id: merge\n    concurrency: { group: g, limit: 1, batch: { max: 5, wait: ${wait} } }\n    ${notify()}\n`,
    );
    expect(result.ok && result.workflow.nodes[0].concurrency?.batch).toEqual({ max: 5, wait: ms });
  });

  test.each([
    ['a zero limit', '{ group: g, limit: 0 }'],
    ['a missing group', '{ limit: 1 }'],
    ['a batch of one', '{ group: g, limit: 1, batch: { max: 1, wait: 1s } }'],
    ['a batch with limit 2', '{ group: g, limit: 2, batch: { max: 3, wait: 1s } }'],
    ['a wait without unit', '{ group: g, limit: 1, batch: { max: 3, wait: soon } }'],
    ['an unknown field', '{ group: g, limit: 1, queue: fifo }'],
  ])('refuses %s', (_label, value) => {
    expect(parse(`  - id: merge\n    concurrency: ${value}\n    ${notify()}\n`).ok).toBe(false);
  });

  test('a group may read inputs, but not node outputs', () => {
    const ok = parse(
      `  - id: merge\n    concurrency: { group: 'merge-{{repo}}-{{inputs.repo}}', limit: 1 }\n    ${notify()}\n`,
    );
    expect(ok.ok).toBe(true);
    const bad = parse(
      `  - id: triage\n    ${notify()}\n  - id: merge\n    depends_on: [triage]\n    concurrency: { group: 'merge-{{triage.output}}', limit: 1 }\n    ${notify()}\n`,
    );
    expect(messages(bad)).toEqual([
      'Node "merge" concurrency.group reads the output of node "triage"; a group may use only the run\'s inputs',
    ]);
  });
});

describe('loops', () => {
  const chain = (loops: Record<string, string>) =>
    ['a', 'b', 'c', 'd']
      .map((id, i) => {
        const deps = i === 0 ? '' : `\n    depends_on: [${'abcd'[i - 1]}]`;
        const loop = loops[id] ? `\n    loop: { until: 'true', back_to: ${loops[id]} }` : '';
        return `  - id: ${id}${deps}${loop}\n    ${notify()}\n`;
      })
      .join('');

  test('several loops, nested, are accepted', () => {
    expect(parse(chain({ b: 'a', d: 'a' })).ok).toBe(true);
  });

  test('several disjoint loops are accepted', () => {
    expect(parse(chain({ b: 'a', d: 'c' })).ok).toBe(true);
  });

  test('overlapping loops are refused, naming both', () => {
    expect(messages(parse(chain({ c: 'a', d: 'b' })))).toEqual([
      'The loops on "c" (back to "a") and "d" (back to "b") overlap; loop regions must be nested or disjoint',
    ]);
  });

  test('back_to must be the node or one it depends on', () => {
    const result = parse(
      `  - id: a\n    ${notify()}\n  - id: b\n    loop: { until: 'true', back_to: a }\n    ${notify()}\n`,
    );
    expect(messages(result)).toEqual([
      'Node "b" loop.back_to "a" must be "b" or a node it depends on, directly or not',
    ]);
  });

  test('back_to may be an indirect dependency', () => {
    expect(parse(chain({ d: 'a' })).ok).toBe(true);
  });
});

describe('host validation', () => {
  test('a host rule refuses a workflow the schema accepted', () => {
    const result = parse(`  - id: a\n    ${notify()}\n`, {
      validate: (wf) => wf.nodes.map((n, i) => ({ path: `nodes.${i}`, message: `no ${n.id}` })),
    });
    expect(result.ok).toBe(false);
    expect(result.ok ? [] : result.error.issues).toEqual([{ path: 'nodes.0', message: 'no a' }]);
  });

  test('a host rule does not run on a workflow the schema refused', () => {
    let called = false;
    parse(`  - id: A\n    ${notify()}\n`, {
      validate: () => {
        called = true;
        return [];
      },
    });
    expect(called).toBe(false);
  });
});
