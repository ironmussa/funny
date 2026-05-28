/**
 * Security HI-3 regression tests — `createProject` / `updateProject` must
 * reject paths outside $HOME (or FUNNY_PROJECT_ROOT), traversal segments,
 * leading-`-` flag-injection, and known system prefixes (/etc, /var, etc.).
 *
 * Without these guards, any logged-in user could register `/etc/passwd`'s
 * containing directory as their "project" and then read it via the file /
 * search / agent-spawn surfaces that trust `project.path`.
 */
import { mock } from 'bun:test';

// The repository runs `isGitRepoSync` on the path — stub it so the FS check
// always succeeds. The containment check (HI-3) is what we want to assert,
// independent of whether the path is actually a git repo on the test
// runner's filesystem.
mock.module('@funny/core/git', () => ({
  isGitRepoSync: () => true,
  isGitRepoRootSync: () => true,
  ensureWeaveConfigured: () => Promise.resolve(),
}));

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { homedir } from 'os';
import { resolve } from 'path';

import { createTestApp, type TestApp } from '../helpers/test-app.js';

let originalProjectRoot: string | undefined;

beforeAll(() => {
  originalProjectRoot = process.env.FUNNY_PROJECT_ROOT;
  // For this test we want to validate against the actual $HOME containment
  // — not the `/tmp` opt-in used elsewhere.
  delete process.env.FUNNY_PROJECT_ROOT;
});

afterAll(() => {
  if (originalProjectRoot !== undefined) process.env.FUNNY_PROJECT_ROOT = originalProjectRoot;
  else delete process.env.FUNNY_PROJECT_ROOT;
});

describe('createProject — path containment (security HI-3)', () => {
  let t: TestApp;
  let createProject: typeof import('../../services/project-repository.js').createProject;

  beforeAll(async () => {
    t = await createTestApp();
    const repo = await import('../../services/project-repository.js');
    createProject = repo.createProject;
  });

  beforeEach(() => {
    t.cleanup();
  });

  test('rejects /etc', async () => {
    const result = await createProject('Evil', '/etc', 'user-1');
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.message).toMatch(/restricted system directory/i);
    }
  });

  test('rejects /var/lib/something', async () => {
    const result = await createProject('Evil2', '/var/lib/anything', 'user-1');
    expect(result.isErr()).toBe(true);
  });

  test('rejects leading-dash (flag-injection guard)', async () => {
    const result = await createProject('Evil3', '-rf', 'user-1');
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      // Either "must be absolute" or "must not start with" — both block it.
      expect(result.error.message).toMatch(/(absolute|must not start with)/i);
    }
  });

  test('rejects ".." segments', async () => {
    const home = homedir();
    const result = await createProject('Evil4', resolve(home, '..', 'other'), 'user-1');
    expect(result.isErr()).toBe(true);
  });

  test('rejects null byte', async () => {
    const result = await createProject('Evil5', '/tmp/a\0/b', 'user-1');
    expect(result.isErr()).toBe(true);
  });

  test('rejects non-absolute path', async () => {
    const result = await createProject('Evil6', 'relative/path', 'user-1');
    expect(result.isErr()).toBe(true);
  });

  test('accepts a path inside $HOME', async () => {
    const home = homedir();
    const path = resolve(home, 'my-project-' + Date.now());
    const result = await createProject('Legit', path, 'user-1');
    expect(result.isOk()).toBe(true);
  });

  test('rejects a path outside $HOME (without FUNNY_PROJECT_ROOT opt-in)', async () => {
    const result = await createProject('Out', '/opt/some-project', 'user-1');
    expect(result.isErr()).toBe(true);
  });

  test('accepts a path inside FUNNY_PROJECT_ROOT when opted in', async () => {
    const prev = process.env.FUNNY_PROJECT_ROOT;
    process.env.FUNNY_PROJECT_ROOT = '/tmp';
    try {
      const path = '/tmp/funny-test-proj-' + Date.now();
      const result = await createProject('OptIn', path, 'user-1');
      expect(result.isOk()).toBe(true);
    } finally {
      if (prev !== undefined) process.env.FUNNY_PROJECT_ROOT = prev;
      else delete process.env.FUNNY_PROJECT_ROOT;
    }
  });
});
