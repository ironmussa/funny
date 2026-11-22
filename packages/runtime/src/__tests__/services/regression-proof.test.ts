/**
 * Regression proof service: job registry, idempotent start, replacement on
 * new head, and unknown-job behavior.
 */

import { describe, expect, test } from 'bun:test';

import { cancelProofJob, getProofJob, startProofJob } from '../../services/regression-proof.js';
import type { ProofRequest } from '../../services/regression-proof.js';

const baseRequest: ProofRequest = {
  headSha: 'abc123',
  defaultBranch: 'main',
  rules: [{ globs: ['**/*.test.ts'], command: 'bun test {{files}}' }],
  supportGlobs: [],
  timeoutMs: 60_000,
};

describe('proof job registry', () => {
  test('start returns a running job', () => {
    const job = startProofJob('thread-1', '/nonexistent', baseRequest);
    expect(job.state).toBe('running');
    expect(job.id).toBeTruthy();
    expect(job.headSha).toBe('abc123');
    job.controller.abort();
  });

  test('a repeated start for the same headSha joins the running job', () => {
    const job1 = startProofJob('thread-2', '/nonexistent', baseRequest);
    const job2 = startProofJob('thread-2', '/nonexistent', baseRequest);
    expect(job2.id).toBe(job1.id);
    job1.controller.abort();
  });

  test('a start with a new headSha replaces the old job', () => {
    const job1 = startProofJob('thread-3', '/nonexistent', baseRequest);
    const newRequest = { ...baseRequest, headSha: 'def456' };
    const job2 = startProofJob('thread-3', '/nonexistent', newRequest);
    expect(job2.id).not.toBe(job1.id);
    expect(job2.headSha).toBe('def456');
    job2.controller.abort();
  });

  test('a start for the same headSha after the job finished runs a new job', async () => {
    const job1 = startProofJob('thread-7', '/nonexistent', baseRequest);
    // '/nonexistent' fails at once: wait for the job to finish.
    for (let i = 0; i < 100 && job1.state !== 'done'; i++) await Bun.sleep(10);
    expect(job1.state).toBe('done');
    expect(job1.result?.headSha).toBe('abc123');
    const job2 = startProofJob('thread-7', '/nonexistent', baseRequest);
    expect(job2.id).not.toBe(job1.id);
    job2.controller.abort();
  });

  test('a cancelled job is stopped and forgotten; an unknown one is not found', () => {
    const job = startProofJob('thread-8', '/nonexistent', baseRequest);
    expect(cancelProofJob('thread-8', 'other-id')).toBe(false);
    expect(cancelProofJob('thread-8', job.id)).toBe(true);
    expect(job.controller.signal.aborted).toBe(true);
    expect(getProofJob('thread-8', job.id)).toBeNull();
  });

  test('getProofJob returns null for unknown proofId', () => {
    startProofJob('thread-4', '/nonexistent', baseRequest);
    const result = getProofJob('thread-4', 'unknown-id');
    expect(result).toBeNull();
  });

  test('getProofJob returns the job for the right proofId', () => {
    const job = startProofJob('thread-5', '/nonexistent', baseRequest);
    const found = getProofJob('thread-5', job.id);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(job.id);
    job.controller.abort();
  });

  test('getProofJob returns null for a different thread', () => {
    const job = startProofJob('thread-6', '/nonexistent', baseRequest);
    const found = getProofJob('thread-other', job.id);
    expect(found).toBeNull();
    job.controller.abort();
  });
});
