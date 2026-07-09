import { describe, expect, test } from 'vitest';

import { buildWorkflowRunBody, parseWorkflowInvocation } from '@/lib/workflow-invocation';

describe('workflow invocation prompt parser', () => {
  test('ignores normal prompts', () => {
    expect(parseWorkflowInvocation('please use >> as text')).toEqual({
      ok: true,
      invocation: null,
    });
  });

  test('parses workflow name and prompt text', () => {
    expect(parseWorkflowInvocation('>> fusion review this diff')).toEqual({
      ok: true,
      invocation: { workflowName: 'fusion', prompt: 'review this diff' },
    });
  });

  test('parses JSON object tail as workflow inputs', () => {
    expect(parseWorkflowInvocation('>> release {"base":"main"}')).toEqual({
      ok: true,
      invocation: { workflowName: 'release', inputs: { base: 'main' } },
    });
  });

  test('rejects invalid JSON object tail', () => {
    expect(parseWorkflowInvocation('>> release {"base":}')).toEqual({
      ok: false,
      error: 'Workflow inputs must be valid JSON.',
    });
  });

  test('adds file and symbol references to run inputs', () => {
    const parsed = parseWorkflowInvocation('>> fusion review');
    expect(
      parsed.ok &&
        parsed.invocation &&
        buildWorkflowRunBody(parsed.invocation, {
          fileReferences: [{ path: 'src/app.ts', type: 'file' }],
          symbolReferences: [{ path: 'src/app.ts', name: 'run', kind: 'function', line: 12 }],
        }),
    ).toEqual({
      prompt: 'review',
      inputs: {
        fileReferences: [{ path: 'src/app.ts', type: 'file' }],
        symbolReferences: [{ path: 'src/app.ts', name: 'run', kind: 'function', line: 12 }],
      },
    });
  });
});
