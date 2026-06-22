import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../git/process.js', () => ({
  execute: vi.fn(),
  ProcessExecutionError: class ProcessExecutionError extends Error {},
}));

import { getPRForBranch } from '../git/github.js';
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
        'number,url,state',
        '--limit',
        '1',
      ],
      { cwd: '/repo', timeout: 10_000, reject: false, env: { GH_TOKEN: 'ghs_test' } },
    );
  });
});
