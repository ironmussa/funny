import { describe, expect, test } from 'vitest';

import {
  githubBrowseBaseUrl,
  githubCommitUrl,
  githubCommitUrlForRemoteCommit,
} from '@/lib/github-url';

describe('github-url', () => {
  test('githubBrowseBaseUrl resolves GitHub HTTPS remotes', () => {
    expect(githubBrowseBaseUrl('https://github.com/acme/funny.git')).toBe(
      'https://github.com/acme/funny',
    );
    expect(githubBrowseBaseUrl('git@github.com:acme/funny.git')).toBe(
      'https://github.com/acme/funny',
    );
  });

  test('githubBrowseBaseUrl returns null for non-GitHub remotes', () => {
    expect(githubBrowseBaseUrl('git@gitlab.com:acme/funny.git')).toBeNull();
    expect(githubBrowseBaseUrl(null)).toBeNull();
    expect(githubBrowseBaseUrl('exists')).toBeNull();
  });

  test('githubCommitUrl builds commit page URLs', () => {
    expect(githubCommitUrl('https://github.com/acme/funny', 'abc123def456')).toBe(
      'https://github.com/acme/funny/commit/abc123def456',
    );
  });

  test('githubCommitUrlForRemoteCommit skips local-only commits', () => {
    expect(
      githubCommitUrlForRemoteCommit('https://github.com/acme/funny', 'abc123def456', false),
    ).toBe('https://github.com/acme/funny/commit/abc123def456');
    expect(
      githubCommitUrlForRemoteCommit('https://github.com/acme/funny', 'abc123def456', true),
    ).toBeNull();
    expect(githubCommitUrlForRemoteCommit(null, 'abc123def456', false)).toBeNull();
  });
});
