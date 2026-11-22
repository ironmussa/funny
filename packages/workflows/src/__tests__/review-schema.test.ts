/**
 * Schema tests for the `review` action and `merge.require_review` (change
 * factory-agent-roles): a flow chooses who reviews and when the review starts;
 * the host owns the rest, so every other field is refused, naming the step.
 */

import { describe, expect, test } from 'bun:test';

import { parseWorkflowYaml } from '../parse.js';

function flow(reviewYaml: string, mergeYaml = 'merge: { method: squash }') {
  return `
name: test-flow
nodes:
  - id: implement
    spawn_agent: { prompt: do it }
  - id: ci
    depends_on: [implement]
    wait_ci: {}
  - id: second-opinion
    depends_on: [ci]
    ${reviewYaml}
  - id: merge
    depends_on: [second-opinion]
    ${mergeYaml}
`.trim();
}

function parse(yaml: string) {
  const result = parseWorkflowYaml(yaml);
  if (!result.ok) throw new Error(`expected valid: ${result.error.message}`);
  return result.workflow;
}

function parseErr(yaml: string) {
  const result = parseWorkflowYaml(yaml);
  if (result.ok) throw new Error('expected invalid');
  return result.error.issues.map((issue) => `${issue.path}: ${issue.message}`).join('\n');
}

const reviewOf = (yaml: string) => parse(yaml).nodes.find((node) => node.review)?.review;

describe('review schema', () => {
  test('an empty review step parses', () => {
    expect(reviewOf(flow('review: {}'))).toEqual({});
  });

  test('provider, model, effort and early are accepted', () => {
    expect(
      reviewOf(flow('review: { provider: codex, model: gpt-5, effort: high, early: false }')),
    ).toEqual({ provider: 'codex', model: 'gpt-5', effort: 'high', early: false });
  });

  test('a write permission mode is refused, naming the step and the field', () => {
    const message = parseErr(flow('review: { permission_mode: autoEdit }'));
    expect(message).toContain('second-opinion');
    expect(message).toContain('permission_mode');
  });

  test('a prompt, tool lists and a thread choice are refused too', () => {
    for (const field of [
      'prompt: hi',
      'allowed_tools: [Edit]',
      'denied_tools: []',
      'thread: continue',
    ]) {
      const message = parseErr(flow(`review: { ${field} }`));
      expect(message).toContain('second-opinion');
      expect(message).toContain(field.split(':')[0]!);
    }
  });

  test('an unknown effort is refused', () => {
    parseErr(flow('review: { effort: extreme }'));
  });

  test('merge takes require_review, and nothing else new', () => {
    const merge = (yaml: string) => parse(yaml).nodes.find((node) => node.merge)?.merge;
    expect(merge(flow('review: {}', 'merge: { require_review: false }'))?.require_review).toBe(
      false,
    );
    expect(merge(flow('review: {}'))?.require_review).toBeUndefined();
    parseErr(flow('review: {}', 'merge: { require_reviews: false }'));
  });
});
