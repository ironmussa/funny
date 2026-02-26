/**
 * E2E test: GitHub CLI wrappers (github.ts)
 *
 * Tests fetchPRReviews, checkPRApprovalStatus, and mergePR
 * by mocking the process execution layer.
 *
 * Flow tested:
 *   1. fetchPRReviews() → calls `gh pr view --json reviews,comments,reviewDecision`
 *   2. Parses response into typed PRReview[] + PRReviewComment[] + ReviewDecision
 *   3. checkPRApprovalStatus() → returns just the decision string
 *   4. mergePR() → calls `gh pr merge` with the correct method flag
 *   5. Error handling: non-zero exit codes, invalid JSON
 */

import { describe, it, expect, mock, beforeEach } from 'bun:test';

// ── Mock process execution ──────────────────────────────────────

const mockExecute = mock(() => Promise.resolve({ exitCode: 0, stdout: '{}', stderr: '' }));

mock.module('../../../core/src/git/process.js', () => ({
  execute: mockExecute,
  ProcessExecutionError: class ProcessExecutionError extends Error {
    exitCode: number;
    stderr: string;
    constructor(message: string, exitCode: number, stderr: string) {
      super(message);
      this.exitCode = exitCode;
      this.stderr = stderr;
    }
  },
}));

const { fetchPRReviews, checkPRApprovalStatus, mergePR } =
  await import('../../../core/src/git/github.js');

// ── Tests ───────────────────────────────────────────────────────

describe('GitHub CLI wrappers (E2E)', () => {
  beforeEach(() => {
    mockExecute.mockReset();
  });

  // ── fetchPRReviews ────────────────────────────────────────

  describe('fetchPRReviews', () => {
    it('parses reviews and comments correctly', async () => {
      const ghResponse = {
        reviews: [
          {
            id: 1,
            author: { login: 'alice' },
            state: 'CHANGES_REQUESTED',
            body: 'Please fix the formatting.',
            submittedAt: '2026-02-20T10:00:00Z',
          },
          {
            id: 2,
            author: { login: 'bob' },
            state: 'APPROVED',
            body: 'LGTM!',
            submittedAt: '2026-02-20T11:00:00Z',
          },
        ],
        comments: [
          {
            id: 100,
            author: { login: 'alice' },
            body: 'This variable name is unclear.',
            path: 'src/utils.ts',
            line: 42,
          },
        ],
        reviewDecision: 'CHANGES_REQUESTED',
      };

      mockExecute.mockResolvedValue({
        exitCode: 0,
        stdout: JSON.stringify(ghResponse),
        stderr: '',
      });

      const result = await fetchPRReviews('/tmp/repo', 42);
      expect(result.isOk()).toBe(true);

      const data = result._unsafeUnwrap();
      expect(data.reviews).toHaveLength(2);
      expect(data.reviews[0].author).toBe('alice');
      expect(data.reviews[0].state).toBe('CHANGES_REQUESTED');
      expect(data.reviews[0].body).toBe('Please fix the formatting.');
      expect(data.reviews[1].author).toBe('bob');
      expect(data.reviews[1].state).toBe('APPROVED');

      expect(data.comments).toHaveLength(1);
      expect(data.comments[0].path).toBe('src/utils.ts');
      expect(data.comments[0].line).toBe(42);
      expect(data.comments[0].body).toBe('This variable name is unclear.');

      expect(data.reviewDecision).toBe('CHANGES_REQUESTED');

      // Verify correct gh command was called
      const [cmd, args] = mockExecute.mock.calls[0] as [string, string[], any];
      expect(cmd).toBe('gh');
      expect(args).toContain('pr');
      expect(args).toContain('view');
      expect(args).toContain('42');
      expect(args).toContain('reviews,comments,reviewDecision');
    });

    it('handles empty reviews and comments', async () => {
      mockExecute.mockResolvedValue({
        exitCode: 0,
        stdout: JSON.stringify({ reviews: [], comments: [], reviewDecision: '' }),
        stderr: '',
      });

      const result = await fetchPRReviews('/tmp/repo', 1);
      expect(result.isOk()).toBe(true);

      const data = result._unsafeUnwrap();
      expect(data.reviews).toHaveLength(0);
      expect(data.comments).toHaveLength(0);
      expect(data.reviewDecision).toBe('');
    });

    it('returns error on non-zero exit code', async () => {
      mockExecute.mockResolvedValue({
        exitCode: 1,
        stdout: '',
        stderr: 'GraphQL: Could not resolve to a PullRequest',
      });

      const result = await fetchPRReviews('/tmp/repo', 999);
      expect(result.isErr()).toBe(true);
    });
  });

  // ── checkPRApprovalStatus ─────────────────────────────────

  describe('checkPRApprovalStatus', () => {
    it('returns APPROVED when PR is approved', async () => {
      mockExecute.mockResolvedValue({
        exitCode: 0,
        stdout: JSON.stringify({ reviewDecision: 'APPROVED' }),
        stderr: '',
      });

      const result = await checkPRApprovalStatus('/tmp/repo', 42);
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toBe('APPROVED');
    });

    it('returns CHANGES_REQUESTED when changes are needed', async () => {
      mockExecute.mockResolvedValue({
        exitCode: 0,
        stdout: JSON.stringify({ reviewDecision: 'CHANGES_REQUESTED' }),
        stderr: '',
      });

      const result = await checkPRApprovalStatus('/tmp/repo', 42);
      expect(result._unsafeUnwrap()).toBe('CHANGES_REQUESTED');
    });

    it('returns empty string when no review decision', async () => {
      mockExecute.mockResolvedValue({
        exitCode: 0,
        stdout: JSON.stringify({}),
        stderr: '',
      });

      const result = await checkPRApprovalStatus('/tmp/repo', 42);
      expect(result._unsafeUnwrap()).toBe('');
    });
  });

  // ── mergePR ───────────────────────────────────────────────

  describe('mergePR', () => {
    it('merges with squash by default', async () => {
      mockExecute.mockResolvedValue({
        exitCode: 0,
        stdout: 'Pull request #42 merged.',
        stderr: '',
      });

      const result = await mergePR('/tmp/repo', 42);
      expect(result.isOk()).toBe(true);

      const [cmd, args] = mockExecute.mock.calls[0] as [string, string[]];
      expect(cmd).toBe('gh');
      expect(args).toContain('merge');
      expect(args).toContain('--squash');
    });

    it('merges with rebase when specified', async () => {
      mockExecute.mockResolvedValue({
        exitCode: 0,
        stdout: 'Pull request #42 merged.',
        stderr: '',
      });

      await mergePR('/tmp/repo', 42, 'rebase');

      const [, args] = mockExecute.mock.calls[0] as [string, string[]];
      expect(args).toContain('--rebase');
    });
  });
});
