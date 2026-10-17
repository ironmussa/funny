/**
 * Security HI-3 regression tests — `createProject` / `updateProject` must
 * reject paths outside $HOME (or FUNNY_PROJECT_ROOT), traversal segments,
 * leading-`-` flag-injection, and known system prefixes (/etc, /var, etc.).
 *
 * Without these guards, any logged-in user could register `/etc/passwd`'s
 * containing directory as their "project" and then read it via the file /
 * search / agent-spawn surfaces that trust `project.path`.
 */
import { mockCoreGitRepoChecks } from '../helpers/module-mocks.js';

// The repository runs `isGitRepoSync` on the path — stub it so the FS check
// always succeeds. The containment check (HI-3) is what we want to assert,
// independent of whether the path is actually a git repo on the test
// runner's filesystem.
// The real path validators (what this suite exercises) stay in place; the
// mock is scoped to this file (see helpers/module-mocks.ts).
mockCoreGitRepoChecks();

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { homedir } from 'os';
import { resolve } from 'path';

import { createTestApp, type TestApp } from '../helpers/test-app.js';

let originalProjectRoot: string | undefined;
let originalPolicy: string | undefined;

beforeAll(() => {
  originalPolicy = process.env.FUNNY_PROJECT_PATH_POLICY;
  process.env.FUNNY_PROJECT_PATH_POLICY = 'restricted';
  originalProjectRoot = process.env.FUNNY_PROJECT_ROOT;
  // For this test we want to validate against the actual $HOME containment
  // — not the `/tmp` opt-in used elsewhere.
  delete process.env.FUNNY_PROJECT_ROOT;
});

afterAll(() => {
  if (originalPolicy === undefined) delete process.env.FUNNY_PROJECT_PATH_POLICY;
  else process.env.FUNNY_PROJECT_PATH_POLICY = originalPolicy;
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

  test('local policy accepts creating and changing a path outside HOME', async () => {
    process.env.FUNNY_PROJECT_PATH_POLICY = 'local';
    try {
      const created = await createProject('External', '/mnt/external/repo', 'user-1');
      expect(created.isOk()).toBe(true);
      if (created.isErr()) return;
      const { updateProject } = await import('../../services/project-repository.js');
      const updated = await updateProject(created.value.id, { path: '/mnt/another/repo' });
      expect(updated.isOk()).toBe(true);
      if (updated.isOk()) expect(updated.value.path).toBe('/mnt/another/repo');
      process.env.FUNNY_PROJECT_PATH_POLICY = 'restricted';
      const rejected = await updateProject(created.value.id, { path: '/mnt/third/repo' });
      expect(rejected.isErr()).toBe(true);
    } finally {
      process.env.FUNNY_PROJECT_PATH_POLICY = 'restricted';
    }
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
