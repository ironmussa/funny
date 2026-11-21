import { describe, expect, test } from 'bun:test';

import { getWorkflowNodeAction, graphToWorkflow, workflowToGraph } from '../graph.js';
import { parseWorkflowYaml } from '../parse.js';

describe('workflow graph conversion', () => {
  test('renders roots, fan-out, fan-in, conditions, retry, approval, loops, and subworkflows', () => {
    const parsed = parseWorkflowYaml(`
name: graph-demo
nodes:
  - id: root
    notify: { message: start }
  - id: left
    depends_on: [root]
    when: 'flag = true'
    run_command: { command: "echo left" }
  - id: right
    depends_on: [root]
    approval:
      message: Continue?
  - id: join
    depends_on: [left, right]
    pipeline:
      name: commit
    retry:
      max_attempts: 2
    loop:
      until: 'done = true'
      back_to: left
`);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const graph = workflowToGraph(parsed.workflow);
    expect(graph.nodes.find((node) => node.id === 'root')?.position.x).toBe(0);
    expect(graph.nodes.find((node) => node.id === 'left')?.data.when).toBe('flag = true');
    expect(graph.nodes.find((node) => node.id === 'right')?.data.actionType).toBe('approval');
    expect(graph.nodes.find((node) => node.id === 'join')?.data.retry?.max_attempts).toBe(2);
    expect(graph.nodes.find((node) => node.id === 'join')?.data.subworkflowName).toBe('commit');
    expect(graph.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: 'root', target: 'left', kind: 'dependency' }),
        expect.objectContaining({ source: 'root', target: 'right', kind: 'dependency' }),
        expect.objectContaining({ source: 'left', target: 'join', kind: 'dependency' }),
        expect.objectContaining({ source: 'right', target: 'join', kind: 'dependency' }),
        expect.objectContaining({ source: 'join', target: 'left', kind: 'loop' }),
        expect.objectContaining({ source: 'join', target: 'commit', kind: 'subworkflow' }),
      ]),
    );
  });

  test('graphToWorkflow writes dependency edits back to the parsed model', () => {
    const parsed = parseWorkflowYaml(`
name: edit-demo
nodes:
  - id: a
    notify: { message: a }
  - id: b
    notify: { message: b }
`);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const graph = workflowToGraph(parsed.workflow);
    graph.edges.push({ id: 'dependency:a->b', source: 'a', target: 'b', kind: 'dependency' });

    const updated = graphToWorkflow(parsed.workflow, graph);
    expect(updated.nodes.find((node) => node.id === 'b')?.depends_on).toEqual(['a']);
  });

  test('names the CI and merge actions instead of unknown', () => {
    const parsed = parseWorkflowYaml(`
name: ci-merge
nodes:
  - id: ci
    wait_ci: {}
  - id: ship
    depends_on: [ci]
    merge: { method: squash }
`);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.workflow.nodes.map((node) => getWorkflowNodeAction(node).type)).toEqual([
      'wait_ci',
      'merge',
    ]);
  });

  test('loop edges carry their region and max iterations; nodes carry join rule and group', () => {
    const parsed = parseWorkflowYaml(`
name: regions
nodes:
  - id: implement
    notify: { message: a }
  - id: side
    notify: { message: b }
  - id: ci
    depends_on: [implement]
    notify: { message: c }
    loop: { until: 'true', back_to: implement, max_iterations: 3 }
  - id: merge
    depends_on: [ci, side]
    trigger_rule: all_done
    concurrency: { group: 'merge-{{repo}}', limit: 1 }
    notify: { message: d }
    loop: { until: 'true', back_to: implement }
`);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const graph = workflowToGraph(parsed.workflow);
    const loops = graph.edges.filter((e) => e.kind === 'loop');
    expect(loops).toEqual([
      expect.objectContaining({
        source: 'ci',
        target: 'implement',
        label: 'loop ×3',
        region: ['implement', 'ci'],
      }),
      expect.objectContaining({
        source: 'merge',
        target: 'implement',
        label: 'loop ×10',
        // `side` feeds merge but is not on a path from implement.
        region: ['implement', 'ci', 'merge'],
      }),
    ]);
    const merge = graph.nodes.find((n) => n.id === 'merge')?.data;
    expect(merge?.triggerRule).toBe('all_done');
    expect(merge?.concurrency).toEqual({ group: 'merge-{{repo}}', limit: 1 });
    expect(graph.nodes.find((n) => n.id === 'ci')?.data.triggerRule).toBeUndefined();
  });
});
