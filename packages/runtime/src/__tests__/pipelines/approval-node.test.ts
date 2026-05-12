/**
 * Approval node unit tests.
 *
 * Validates the human-in-the-loop semantics:
 *   - approve resolves and continues the pipeline
 *   - reject throws ApprovalRejectedError, failing the pipeline
 *   - captureResponse stores the approver's comment on ctx
 *   - onReject hook runs before the throw and may augment context
 *   - when=false skips the gate entirely
 *   - message accepts a function-of-context
 */

import { runPipeline, definePipeline, nullReporter, node } from '@funny/pipelines';
import { describe, test, expect, vi } from 'vitest';

import {
  approvalNode,
  ApprovalRejectedError,
  type ApprovalCapturedOutputs,
} from '../../pipelines/approval.js';
import type { ActionProvider, ApprovalDecision, PipelineContext } from '../../pipelines/types.js';

// ── Helpers ──────────────────────────────────────────────────

interface TestCtx extends PipelineContext, ApprovalCapturedOutputs {
  branch: string;
  flag?: string;
}

function mockProvider(
  approval: ApprovalDecision | (() => Promise<ApprovalDecision>),
): ActionProvider {
  return {
    spawnAgent: vi.fn().mockResolvedValue({ ok: true, output: '' }),
    runCommand: vi.fn().mockResolvedValue({ ok: true, output: '' }),
    gitCommit: vi.fn().mockResolvedValue({ ok: true, output: '' }),
    gitPush: vi.fn().mockResolvedValue({ ok: true, output: '' }),
    createPr: vi.fn().mockResolvedValue({ ok: true, output: '' }),
    notify: vi.fn().mockResolvedValue({ ok: true }),
    setStatus: vi.fn().mockResolvedValue({ ok: true }),
    setStage: vi.fn().mockResolvedValue({ ok: true }),
    requestApproval: vi
      .fn()
      .mockImplementation(
        typeof approval === 'function' ? approval : () => Promise.resolve(approval),
      ),
  };
}

function baseCtx(provider: ActionProvider): TestCtx {
  return { provider, progress: nullReporter, cwd: '/repo', branch: 'feature/x' };
}

// ── Tests ────────────────────────────────────────────────────

describe('approvalNode', () => {
  test('approve continues the pipeline', async () => {
    const provider = mockProvider({ decision: 'approve' });
    const after = vi.fn(async (ctx: TestCtx) => ({ ...ctx, flag: 'ran' }));

    const pipeline = definePipeline<TestCtx>({
      name: 'gated',
      nodes: [
        approvalNode<TestCtx>('confirm', { message: 'proceed?' }),
        node<TestCtx>('after', after),
      ],
    });

    const result = await runPipeline(pipeline, baseCtx(provider));

    expect(result.outcome).toBe('completed');
    expect(after).toHaveBeenCalledOnce();
    expect(provider.requestApproval).toHaveBeenCalledWith(
      expect.objectContaining({ gateId: 'confirm', message: 'proceed?' }),
    );
  });

  test('reject throws ApprovalRejectedError and fails the pipeline', async () => {
    const provider = mockProvider({ decision: 'reject', reason: 'too risky' });
    const after = vi.fn(async (ctx: TestCtx) => ctx);

    const pipeline = definePipeline<TestCtx>({
      name: 'gated',
      nodes: [
        approvalNode<TestCtx>('confirm', { message: 'proceed?' }),
        node<TestCtx>('after', after),
      ],
    });

    const result = await runPipeline(pipeline, baseCtx(provider));

    expect(result.outcome).toBe('failed');
    expect(result.error).toContain('too risky');
    expect(after).not.toHaveBeenCalled();
  });

  test('captureResponse stores the comment on ctx.approvalOutputs', async () => {
    const provider = mockProvider({ decision: 'approve', comment: 'looks good' });

    const pipeline = definePipeline<TestCtx>({
      name: 'gated',
      nodes: [approvalNode<TestCtx>('confirm', { message: 'proceed?', captureResponse: true })],
    });

    const result = await runPipeline(pipeline, baseCtx(provider));

    expect(result.outcome).toBe('completed');
    expect(result.ctx.approvalOutputs).toEqual({ confirm: 'looks good' });
  });

  test('does not write approvalOutputs when captureResponse is false', async () => {
    const provider = mockProvider({ decision: 'approve', comment: 'ignored' });

    const pipeline = definePipeline<TestCtx>({
      name: 'gated',
      nodes: [approvalNode<TestCtx>('confirm', { message: 'proceed?' })],
    });

    const result = await runPipeline(pipeline, baseCtx(provider));

    expect(result.ctx.approvalOutputs).toBeUndefined();
  });

  test('captures empty string when approver provides no comment', async () => {
    const provider = mockProvider({ decision: 'approve' });

    const pipeline = definePipeline<TestCtx>({
      name: 'gated',
      nodes: [approvalNode<TestCtx>('confirm', { message: 'proceed?', captureResponse: true })],
    });

    const result = await runPipeline(pipeline, baseCtx(provider));
    expect(result.ctx.approvalOutputs).toEqual({ confirm: '' });
  });

  test('onReject runs with the rejection reason before the throw', async () => {
    const provider = mockProvider({ decision: 'reject', reason: 'breaks contract' });
    const onReject = vi.fn(async (_reason: string, _ctx: TestCtx) => {});

    const pipeline = definePipeline<TestCtx>({
      name: 'gated',
      nodes: [
        approvalNode<TestCtx>('confirm', {
          message: 'proceed?',
          onReject,
        }),
      ],
    });

    const result = await runPipeline(pipeline, baseCtx(provider));

    expect(result.outcome).toBe('failed');
    expect(onReject).toHaveBeenCalledWith('breaks contract', expect.any(Object));
  });

  test('onReject thrown error replaces the rejection error', async () => {
    const provider = mockProvider({ decision: 'reject', reason: 'no' });

    const pipeline = definePipeline<TestCtx>({
      name: 'gated',
      nodes: [
        approvalNode<TestCtx>('confirm', {
          message: 'proceed?',
          onReject: async () => {
            throw new Error('on_reject custom failure');
          },
        }),
      ],
    });

    const result = await runPipeline(pipeline, baseCtx(provider));

    expect(result.outcome).toBe('failed');
    expect(result.error).toContain('on_reject custom failure');
  });

  test('when=false skips the gate without calling requestApproval', async () => {
    const provider = mockProvider({ decision: 'reject', reason: 'never reached' });

    const pipeline = definePipeline<TestCtx>({
      name: 'gated',
      nodes: [approvalNode<TestCtx>('confirm', { message: 'proceed?', when: () => false })],
    });

    const result = await runPipeline(pipeline, baseCtx(provider));

    expect(result.outcome).toBe('completed');
    expect(provider.requestApproval).not.toHaveBeenCalled();
  });

  test('message can be a function of context', async () => {
    const provider = mockProvider({ decision: 'approve' });

    const pipeline = definePipeline<TestCtx>({
      name: 'gated',
      nodes: [
        approvalNode<TestCtx>('confirm', {
          message: (ctx) => `push ${ctx.branch}?`,
        }),
      ],
    });

    await runPipeline(pipeline, baseCtx(provider));

    expect(provider.requestApproval).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'push feature/x?' }),
    );
  });

  test('forwards timeoutMs to the provider', async () => {
    const provider = mockProvider({ decision: 'approve' });

    const pipeline = definePipeline<TestCtx>({
      name: 'gated',
      nodes: [approvalNode<TestCtx>('confirm', { message: 'proceed?', timeoutMs: 60_000 })],
    });

    await runPipeline(pipeline, baseCtx(provider));

    expect(provider.requestApproval).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 60_000 }),
    );
  });

  test('reports step progress: running → completed on approve', async () => {
    const onStepProgress = vi.fn();
    const onPipelineEvent = vi.fn();
    const provider = mockProvider({ decision: 'approve' });

    const pipeline = definePipeline<TestCtx>({
      name: 'gated',
      nodes: [approvalNode<TestCtx>('confirm', { message: 'proceed?' })],
    });

    const ctx = { ...baseCtx(provider), progress: { onStepProgress, onPipelineEvent } };
    await runPipeline(pipeline, ctx);

    expect(onStepProgress).toHaveBeenCalledWith('confirm', { status: 'running' });
    expect(onStepProgress).toHaveBeenCalledWith('confirm', { status: 'completed' });
  });

  test('reports step progress: running → failed on reject', async () => {
    const onStepProgress = vi.fn();
    const onPipelineEvent = vi.fn();
    const provider = mockProvider({ decision: 'reject', reason: 'nope' });

    const pipeline = definePipeline<TestCtx>({
      name: 'gated',
      nodes: [approvalNode<TestCtx>('confirm', { message: 'proceed?' })],
    });

    const ctx = { ...baseCtx(provider), progress: { onStepProgress, onPipelineEvent } };
    await runPipeline(pipeline, ctx);

    expect(onStepProgress).toHaveBeenCalledWith('confirm', { status: 'running' });
    expect(onStepProgress).toHaveBeenCalledWith(
      'confirm',
      expect.objectContaining({ status: 'failed', error: 'nope' }),
    );
  });

  test('ApprovalRejectedError carries gateId and reason', () => {
    const err = new ApprovalRejectedError('confirm', 'too risky');
    expect(err.gateId).toBe('confirm');
    expect(err.reason).toBe('too risky');
    expect(err.message).toContain('confirm');
    expect(err.message).toContain('too risky');
  });
});
