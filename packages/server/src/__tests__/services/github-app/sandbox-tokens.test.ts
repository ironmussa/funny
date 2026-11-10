import { describe, expect, test } from 'bun:test';

import { errAsync, okAsync } from 'neverthrow';

import {
  createSandboxTokenService,
  githubRepoOf,
  type SandboxThreadFacts,
} from '../../../services/github-app/sandbox-tokens.js';

const FACTS: SandboxThreadFacts = {
  ownerId: 'alice',
  projectId: 'p1',
  repoUrl: 'https://github.com/Acme/App.git',
  usable: true,
};

function setup(facts: SandboxThreadFacts | null, ownerToken: string | null = 'ghp_alice') {
  const issued: Array<[string, string | null]> = [];
  const service = createSandboxTokenService({
    thread: async () => facts,
    ownerToken: async () => ownerToken,
    issue: (repo, token) => {
      issued.push([repo, token]);
      return okAsync({
        token: 'ghs_x',
        expiresAt: '2026-11-10T13:00:00Z',
        repo,
        level: 'write' as const,
      });
    },
  });
  return { service, issued };
}

describe('githubRepoOf', () => {
  test('reads owner/name from GitHub URLs only', () => {
    expect(githubRepoOf('https://github.com/Acme/App.git')).toBe('acme/app');
    expect(githubRepoOf('git@github.com:acme/app.git')).toBe('acme/app');
    expect(githubRepoOf('https://gitlab.com/acme/app.git')).toBeNull();
    expect(githubRepoOf('https://github.com/acme/app/../x')).toBeNull();
  });
});

describe('sandbox GitHub tokens', () => {
  test("a running sandbox thread gets a token for its own repository, checked with its owner's token", async () => {
    const { service, issued } = setup(FACTS);
    const token = await service.issueFor('t-1');
    expect(token.isOk() && token.value.repo).toBe('acme/app');
    expect(issued).toEqual([['acme/app', 'ghp_alice']]);
  });

  test('no token for a missing, archived or stopped sandbox thread, or a non-GitHub repository', async () => {
    for (const facts of [
      null,
      { ...FACTS, usable: false },
      { ...FACTS, repoUrl: 'https://gitlab.com/acme/app.git' },
      { ...FACTS, repoUrl: null },
    ]) {
      const { service, issued } = setup(facts);
      const result = await service.issueFor('t-1');
      expect(result.isErr() && result.error.kind).toBe('no-access');
      expect(issued).toEqual([]);
    }
  });

  test("the issuer's refusal reaches the runner as a typed error", async () => {
    const service = createSandboxTokenService({
      thread: async () => FACTS,
      ownerToken: async () => 'ghp_alice',
      issue: () =>
        errAsync({ kind: 'not-installed' as const, message: 'not installed on acme/app' }),
    });
    const result = await service.issueFor('t-1');
    expect(result.isErr() && result.error.kind).toBe('not-installed');
  });

  test('a refusal the user can fix is told to the thread once per reason; transient errors are not', async () => {
    const told: string[] = [];
    let kind: 'not-installed' | 'no-access' | 'github-error' = 'not-installed';
    const service = createSandboxTokenService({
      thread: async () => FACTS,
      ownerToken: async () => 'ghp_alice',
      issue: () => errAsync({ kind, message: kind }),
      notify: (threadId, ownerId, error) => told.push(`${threadId}:${ownerId}:${error.kind}`),
    });
    await service.issueFor('t-1');
    await service.issueFor('t-1');
    kind = 'github-error';
    await service.issueFor('t-1');
    kind = 'no-access';
    await service.issueFor('t-1');
    expect(told).toEqual(['t-1:alice:not-installed', 't-1:alice:no-access']);
  });
});
