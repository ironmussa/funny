import { describe, expect, test } from 'vitest';

import { parseWorkflowYaml } from '../parse.js';
import { serializeWorkflow } from '../serialize.js';

describe('serializeWorkflow', () => {
  test('round-trips parsed workflow YAML without synthetic defaults', () => {
    const parsed = parseWorkflowYaml(`
name: sample
description: Demo
inputs:
  prompt: { type: string, required: true }
nodes:
  - id: ask
    spawn_agent:
      prompt: "{{prompt}}"
  - id: done
    depends_on: [ask]
    on_error: continue
    notify:
      message: Done
`);

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const yaml = serializeWorkflow(parsed.workflow);
    expect(yaml).toContain('name: sample');
    expect(yaml).toContain('depends_on');
    expect(yaml).toContain('on_error: continue');
    expect(yaml).not.toContain('on_error: fail');
    expect(yaml).not.toContain('depends_on: []');

    const reparsed = parseWorkflowYaml(yaml);
    expect(reparsed.ok).toBe(true);
    if (reparsed.ok) expect(reparsed.workflow).toEqual(parsed.workflow);
  });

  test('round-trips the CI and merge nodes', () => {
    const parsed = parseWorkflowYaml(`
name: ci-merge
nodes:
  - id: ci
    wait_ci:
      timeout_ms: 600000
      required_checks: [build]
  - id: ship
    depends_on: [ci]
    merge:
      method: squash
      delete_branch: true
`);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const yaml = serializeWorkflow(parsed.workflow);
    expect(yaml).toContain('wait_ci');
    expect(yaml).toContain('merge');
    const reparsed = parseWorkflowYaml(yaml);
    expect(reparsed.ok).toBe(true);
    if (reparsed.ok) expect(reparsed.workflow).toEqual(parsed.workflow);
  });
});
