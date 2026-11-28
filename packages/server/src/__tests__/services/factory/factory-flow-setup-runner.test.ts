/**
 * The runner client reads the runtime's verification answer in the runtime's
 * own shape (`verdicts`, `prunedYaml`, `outputTail`) and maps it to the
 * contract's (`rules`, `prunedWorkflowYaml`, `output`). The fixture is typed
 * with the schema the runtime route `satisfies`, so a change on either side
 * fails the typecheck.
 */

import { describe, expect, test } from 'bun:test';

import type { verifyFlowSetupPollAnswerSchema } from '@ironmussa/funny-runtime/validation/schemas';
import type { z } from 'zod';

import { decodeVerifyPoll } from '../../../services/factory/factory-flow-setup-runner.js';

const run = (files: string[], exitCode: number) => ({
  command: `bunx jest ${files.join(' ')}`,
  files,
  exitCode,
  timedOut: false,
  aborted: false,
  outputTail: `PASS ${files.join(' ')}`,
});

const answer = (body: z.input<typeof verifyFlowSetupPollAnswerSchema>) => ({
  status: 200,
  body: JSON.stringify(body),
});

describe('decodeVerifyPoll', () => {
  test('maps a finished runtime job to the contract shape', () => {
    const decoded = decodeVerifyPoll(
      answer({
        state: 'done',
        result: {
          ok: true,
          verdicts: [
            {
              ruleIndex: 0,
              globs: ['**/*.spec.ts'],
              command: 'bunx jest {{files}}',
              accepted: true,
              passingRun: run(['a.canary.spec.ts'], 0),
              failingRun: run(['b.canary.spec.ts'], 1),
              existingRun: run(['src/x.spec.ts'], 0),
              twoFileRun: run(['a.canary.spec.ts', 'src/x.spec.ts'], 0),
            },
            {
              ruleIndex: 1,
              globs: ['**/*.e2e.ts'],
              command: 'bunx jest {{files}}',
              accepted: false,
              reason: 'No existing non-infrastructure test file matched the rule globs',
            },
          ],
          prunedYaml: 'name: issue-to-merge\n',
          acceptedCount: 1,
          rejectedCount: 1,
        },
      }),
    )._unsafeUnwrap();

    expect(decoded.state).toBe('done');
    if (decoded.state !== 'done') return;
    expect(decoded.result.prunedWorkflowYaml).toBe('name: issue-to-merge\n');
    expect(decoded.result.acceptedCount).toBe(1);
    expect(decoded.result.timedOut).toBe(false);
    expect(decoded.result.rules[0]?.passingCanary?.output).toBe('PASS a.canary.spec.ts');
    expect(decoded.result.rules[0]?.existingTest?.files).toEqual(['src/x.spec.ts']);
    expect(decoded.result.rules[1]?.rejectionReason).toContain('No existing');
  });

  test('keeps the runner finding of a job that failed as a whole', () => {
    const decoded = decodeVerifyPoll(
      answer({
        state: 'done',
        result: {
          ok: false,
          failureReason: 'setup-failed',
          finding: 'Setup command `pnpm i` exited with code 1',
          setupOutputTail: 'ERR_PNPM',
          verdicts: [],
          prunedYaml: null,
          acceptedCount: 0,
          rejectedCount: 2,
        },
      }),
    )._unsafeUnwrap();

    expect(decoded).toEqual({
      state: 'done',
      result: {
        finding: 'Setup command `pnpm i` exited with code 1',
        setupOutput: 'ERR_PNPM',
        rules: [],
        acceptedCount: 0,
        rejectedCount: 2,
        prunedWorkflowYaml: null,
        timedOut: false,
      },
    });
  });

  test('refuses an answer that is not the runtime shape', () => {
    const decoded = decodeVerifyPoll({
      status: 200,
      body: JSON.stringify({ state: 'done', result: { rules: [], prunedWorkflowYaml: null } }),
    });
    expect(decoded.isErr()).toBe(true);
    expect(decoded._unsafeUnwrapErr().kind).toBe('runner-error');
  });

  test('a running job stays running', () => {
    expect(decodeVerifyPoll(answer({ state: 'running' }))._unsafeUnwrap()).toEqual({
      state: 'running',
    });
  });
});
