/**
 * The journal codec reads back the step outputs a journal stored as JSON:
 * each one a `NodeOutput` (issue #557 typed them as JSON instead of `unknown`).
 */
import { describe, expect, test } from 'bun:test';

import { nullReporter } from '@funny/pipelines';
import type { ActionProvider, YamlPipelineContext } from '@funny/workflows/compiler';

import { journalCodec } from '../../../services/factory/factory-flow-runs-support.js';

const live: YamlPipelineContext = {
  // SAFETY: decode never calls the provider; it only carries it into the context.
  provider: {} as ActionProvider,
  progress: nullReporter,
  cwd: '/repo',
  inputs: { threadId: 't1' },
  outputs: {},
};

describe('journalCodec', () => {
  test('round-trips the step outputs through JSON', () => {
    const codec = journalCodec(live);
    const outputs = {
      implement: { output: 'done', json: { sha: 'abc', checks: [{ name: 'ci' }] } },
      review: { output: { verdict: 'pass' }, error: 'retried once' },
    };
    const stored = JSON.parse(JSON.stringify(codec.encode({ ...live, outputs })));
    const decoded = codec.decode(stored);
    expect(decoded.outputs).toEqual(outputs);
    expect(decoded.inputs).toBe(live.inputs);
  });

  test('an output JSON dropped reads back as absent', () => {
    const decoded = journalCodec(live).decode({ notify: {} });
    expect(decoded.outputs.notify).toEqual({});
    expect(decoded.outputs.notify?.output).toBeUndefined();
  });

  test('a json or error of another shape reads as absent instead of failing the resume', () => {
    const decoded = journalCodec(live).decode({ step: { output: 'x', json: [1, 2], error: 3 } });
    expect(decoded.outputs.step).toEqual({ output: 'x' });
  });
});
