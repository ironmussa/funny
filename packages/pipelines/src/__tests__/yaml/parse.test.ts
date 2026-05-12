/**
 * YAML pipeline parser + schema tests.
 *
 * Validates the boundary contract: well-formed YAML with valid schema
 * yields a typed `ParsedPipeline`; malformed inputs yield structured
 * errors with diagnostic paths.
 */

import { describe, expect, test } from 'vitest';

import { formatParseError, parsePipelineYaml } from '../../yaml/parse.js';

const validMinimal = `
name: minimal
nodes:
  - id: greet
    notify:
      message: hello
`.trim();

describe('parsePipelineYaml', () => {
  test('accepts a minimal valid pipeline', () => {
    const result = parsePipelineYaml(validMinimal);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.pipeline.name).toBe('minimal');
      expect(result.pipeline.nodes).toHaveLength(1);
      expect(result.pipeline.nodes[0].notify?.message).toBe('hello');
    }
  });

  test('rejects malformed YAML with a diagnostic message', () => {
    const result = parsePipelineYaml('name: foo\n  bad indent: [\n');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('Invalid YAML');
    }
  });

  test('rejects empty input', () => {
    const result = parsePipelineYaml('');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('empty');
    }
  });

  test('rejects pipelines with zero nodes', () => {
    const result = parsePipelineYaml('name: empty\nnodes: []');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.issues.some((i) => i.message.includes('at least one node'))).toBe(true);
    }
  });

  test('rejects nodes with no action declared', () => {
    const yaml = `
name: bad
nodes:
  - id: idle
`;
    const result = parsePipelineYaml(yaml);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.error.issues.some((i) => i.message.includes('must declare exactly one action')),
      ).toBe(true);
    }
  });

  test('rejects nodes with multiple actions', () => {
    const yaml = `
name: bad
nodes:
  - id: confused
    notify:
      message: "hi"
    git_push:
      branch: main
`;
    const result = parsePipelineYaml(yaml);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.issues.some((i) => i.message.includes('multiple actions'))).toBe(true);
    }
  });

  test('rejects unknown top-level fields (strict mode)', () => {
    const yaml = `
name: bad
unknown_field: 1
nodes:
  - id: a
    notify:
      message: hi
`;
    const result = parsePipelineYaml(yaml);
    expect(result.ok).toBe(false);
  });

  test('rejects invalid pipeline names (uppercase, special chars)', () => {
    const yaml = `
name: BadName
nodes:
  - id: a
    notify:
      message: hi
`;
    const result = parsePipelineYaml(yaml);
    expect(result.ok).toBe(false);
  });

  test('rejects depends_on referencing unknown nodes', () => {
    const yaml = `
name: dag
nodes:
  - id: a
    depends_on: [ghost]
    notify:
      message: hi
`;
    const result = parsePipelineYaml(yaml);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.issues.some((i) => i.message.includes('unknown node "ghost"'))).toBe(
        true,
      );
    }
  });

  test('rejects self-dependency', () => {
    const yaml = `
name: dag
nodes:
  - id: a
    depends_on: [a]
    notify:
      message: hi
`;
    const result = parsePipelineYaml(yaml);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.issues.some((i) => i.message.includes('cannot depend on itself'))).toBe(
        true,
      );
    }
  });

  test('rejects duplicate node ids', () => {
    const yaml = `
name: dup
nodes:
  - id: a
    notify: { message: hi }
  - id: a
    notify: { message: hi }
`;
    const result = parsePipelineYaml(yaml);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.issues.some((i) => i.message.includes('Duplicate node id'))).toBe(true);
    }
  });

  test('accepts a full pipeline with all action types', () => {
    const yaml = `
name: full
description: smoke test
defaults:
  provider: claude
  model: sonnet
inputs:
  branch:  { type: string, required: true }
  message: { type: string, default: 'wip' }

nodes:
  - id: review
    spawn_agent:
      agent: reviewer
      prompt: "Review {{branch}}"
      allowed_tools: [Read, Grep]
      denied_tools: [Edit, Write]
      output_format:
        type: object
        properties: { verdict: { type: string } }
        required: [verdict]

  - id: test
    depends_on: [review]
    when: 'review.output.verdict = "pass"'
    run_command:
      command: "bun test"

  - id: gate
    depends_on: [test]
    approval:
      message: "Push {{branch}}?"
      capture_response: true
      timeout_ms: 60000

  - id: commit
    depends_on: [gate]
    git_commit:
      message: "{{message}}"
      no_verify: true

  - id: push
    depends_on: [commit]
    git_push:
      branch: "{{branch}}"
      set_upstream: true
    retry:
      max_attempts: 3
      delay_ms: 1000
      should_retry: 'attempt < 3'

  - id: pr
    depends_on: [push]
    on_error: continue
    create_pr:
      title: "{{message}}"
      base: main

  - id: done
    depends_on: [pr]
    notify:
      message: "Done"
      level: info
`;
    const result = parsePipelineYaml(yaml);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.pipeline.nodes).toHaveLength(7);
    }
  });

  test('accepts set_status / set_stage actions with optional reason', () => {
    const yaml = `
name: lifecycle
nodes:
  - id: start
    set_status:
      value: running
      reason: "kicked off"
  - id: advance
    depends_on: [start]
    set_stage:
      value: in_progress
`;
    const result = parsePipelineYaml(yaml);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.pipeline.nodes[0].set_status?.value).toBe('running');
      expect(result.pipeline.nodes[0].set_status?.reason).toBe('kicked off');
      expect(result.pipeline.nodes[1].set_stage?.value).toBe('in_progress');
    }
  });

  test('rejects set_status without value (strict mode)', () => {
    const yaml = `
name: bad-status
nodes:
  - id: a
    set_status:
      reason: "missing value"
`;
    const result = parsePipelineYaml(yaml);
    expect(result.ok).toBe(false);
  });

  test('rejects set_stage with extra unknown fields (strict mode)', () => {
    const yaml = `
name: bad-stage
nodes:
  - id: a
    set_stage:
      value: review
      bogus: 1
`;
    const result = parsePipelineYaml(yaml);
    expect(result.ok).toBe(false);
  });

  test('rejects a node that declares both set_status and set_stage', () => {
    const yaml = `
name: bad-mix
nodes:
  - id: a
    set_status:
      value: running
    set_stage:
      value: in_progress
`;
    const result = parsePipelineYaml(yaml);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.issues.some((i) => i.message.includes('multiple actions'))).toBe(true);
    }
  });

  test('formatParseError renders the issues as multi-line text', () => {
    const result = parsePipelineYaml('name: BadName\nnodes: []');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const txt = formatParseError(result.error);
      expect(txt.split('\n').length).toBeGreaterThan(1);
    }
  });
});
