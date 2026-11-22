/**
 * Regression proof service: job registry, idempotent start, replacement on
 * new head, and unknown-job behavior.
 */

import { describe, expect, test } from 'bun:test';

import { startProofJob, getProofJob } from '../../services/regression-proof.js';
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
    const job = startProofJob('thread-1', '/nonexistent', null, baseRequest);
    expect(job.state).toBe('running');
    expect(job.id).toBeTruthy();
    expect(job.headSha).toBe('abc123');
    job.controller.abort();
  });

  test('a repeated start for the same headSha joins the running job', () => {
    const job1 = startProofJob('thread-2', '/nonexistent', null, baseRequest);
    const job2 = startProofJob('thread-2', '/nonexistent', null, baseRequest);
    expect(job2.id).toBe(job1.id);
    job1.controller.abort();
  });

  test('a start with a new headSha replaces the old job', () => {
    const job1 = startProofJob('thread-3', '/nonexistent', null, baseRequest);
    const newRequest = { ...baseRequest, headSha: 'def456' };
    const job2 = startProofJob('thread-3', '/nonexistent', null, newRequest);
    expect(job2.id).not.toBe(job1.id);
    expect(job2.headSha).toBe('def456');
    job2.controller.abort();
  });

  test('getProofJob returns null for unknown proofId', () => {
    startProofJob('thread-4', '/nonexistent', null, baseRequest);
    const result = getProofJob('thread-4', 'unknown-id');
    expect(result).toBeNull();
  });

  test('getProofJob returns the job for the right proofId', () => {
    const job = startProofJob('thread-5', '/nonexistent', null, baseRequest);
    const found = getProofJob('thread-5', job.id);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(job.id);
    job.controller.abort();
  });

  test('getProofJob returns null for a different thread', () => {
    const job = startProofJob('thread-6', '/nonexistent', null, baseRequest);
    const found = getProofJob('thread-other', job.id);
    expect(found).toBeNull();
    job.controller.abort();
  });
});
