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
});
