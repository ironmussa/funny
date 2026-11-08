import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../git/process.js', () => ({
  execute: vi.fn(),
  ProcessExecutionError: class ProcessExecutionError extends Error {},
}));

import { getPRForBranch, lookupPRForBranch } from '../git/github.js';
import { execute } from '../git/process.js';

const mockExecute = execute as ReturnType<typeof vi.fn>;

describe('getPRForBranch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('queries all pull request states for a branch', async () => {
    mockExecute.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify([
        {
          number: 42,
          url: 'https://github.com/acme/repo/pull/42',
          state: 'MERGED',
          headRefName: 'feature/x',
        },
      ]),
      stderr: '',
    });

    const pr = await getPRForBranch('/repo', 'feature/x', { GH_TOKEN: 'ghs_test' });

    expect(pr).toEqual({
      prNumber: 42,
      prUrl: 'https://github.com/acme/repo/pull/42',
      prState: 'MERGED',
    });
    expect(mockExecute).toHaveBeenCalledWith(
      'gh',
      [
        'pr',
        'list',
        '--head',
        'feature/x',
        '--state',
        'all',
        '--json',
        'number,url,state,headRefName',
        '--limit',
        '10',
      ],
      { cwd: '/repo', timeout: 10_000, reject: false, env: { GH_TOKEN: 'ghs_test' } },
    );
  });

  test('ignores pull requests whose head branch does not exactly match', async () => {
    mockExecute.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify([
        {
          number: 50,
          url: 'https://github.com/acme/repo/pull/50',
          state: 'OPEN',
          headRefName: 'argenisleon/gol-771-sechigh-e3-logs',
        },
      ]),
      stderr: '',
    });

    const pr = await getPRForBranch('/repo', 'argenisleon/gol-770-sechigh-e2-helmet');

    expect(pr).toBeNull();
  });

  test('selects the exact branch when gh returns multiple candidates', async () => {
    mockExecute.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify([
        {
          number: 50,
          url: 'https://github.com/acme/repo/pull/50',
          state: 'OPEN',
          headRefName: 'argenisleon/gol-771-sechigh-e3-logs',
        },
        {
          number: 51,
          url: 'https://github.com/acme/repo/pull/51',
          state: 'OPEN',
          headRefName: 'argenisleon/gol-770-sechigh-e2-helmet',
        },
      ]),
      stderr: '',
    });

    const pr = await getPRForBranch('/repo', 'argenisleon/gol-770-sechigh-e2-helmet');

    expect(pr).toEqual({
      prNumber: 51,
      prUrl: 'https://github.com/acme/repo/pull/51',
      prState: 'OPEN',
    });
  });

  test('matches owner-qualified head filters by branch name', async () => {
    mockExecute.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify([
        {
          number: 52,
          url: 'https://github.com/acme/repo/pull/52',
          state: 'OPEN',
          headRefName: 'feature/x',
        },
      ]),
      stderr: '',
    });

    const pr = await getPRForBranch('/repo', 'acme:feature/x');

    expect(pr?.prNumber).toBe(52);
  });
});

describe('lookupPRForBranch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('tells a failed gh call apart from a branch without a PR', async () => {
    mockExecute.mockResolvedValueOnce({
      exitCode: 1,
      stdout: '',
      stderr: 'API rate limit exceeded',
    });
    const failed = await lookupPRForBranch('/repo', 'feature/x');
    expect(failed.isErr()).toBe(true);

    mockExecute.mockResolvedValueOnce({ exitCode: 0, stdout: '[]', stderr: '' });
    const none = await lookupPRForBranch('/repo', 'feature/x');
    expect(none.isOk() && none.value).toBeNull();
  });

  test('reports a timeout or spawn error and invalid output as failures', async () => {
    mockExecute.mockRejectedValueOnce(new Error('timed out'));
    expect((await lookupPRForBranch('/repo', 'feature/x')).isErr()).toBe(true);

    mockExecute.mockResolvedValueOnce({ exitCode: 0, stdout: 'not json', stderr: '' });
    expect((await lookupPRForBranch('/repo', 'feature/x')).isErr()).toBe(true);
  });

  test('getPRForBranch keeps reporting failures as no PR', async () => {
    mockExecute.mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'auth required' });
    expect(await getPRForBranch('/repo', 'feature/x')).toBeNull();
  });
});
