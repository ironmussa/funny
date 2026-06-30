import { describe, expect, test } from 'vitest';

import { workflowToGraph, graphToWorkflow } from '../graph.js';
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
});
