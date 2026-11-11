/**
 * The per-project switch that redirects Claude's raw check commands to
 * `funny_run_checks`: on unless the user turns it off, and only an explicit
 * off is carried on the project (absent means on).
 */
import { mockCoreGitRepoChecks } from '../helpers/module-mocks.js';

mockCoreGitRepoChecks();

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';

import { createTestApp, type TestApp } from '../helpers/test-app.js';

let originalPolicy: string | undefined;

beforeAll(() => {
  originalPolicy = process.env.FUNNY_PROJECT_PATH_POLICY;
  process.env.FUNNY_PROJECT_PATH_POLICY = 'local';
});

afterAll(() => {
  if (originalPolicy === undefined) delete process.env.FUNNY_PROJECT_PATH_POLICY;
  else process.env.FUNNY_PROJECT_PATH_POLICY = originalPolicy;
});

describe('project redirectChecks', () => {
  let t: TestApp;
  let repo: typeof import('../../services/project-repository.js');

  beforeAll(async () => {
    t = await createTestApp();
    repo = await import('../../services/project-repository.js');
  });

  beforeEach(() => {
    t.cleanup();
  });

  test('is on by default, turns off, and turns back on', async () => {
    const created = await repo.createProject('Checks', '/mnt/external/checks', 'user-1');
    if (created.isErr()) throw new Error(created.error.message);
    const id = created.value.id;
    expect(created.value.redirectChecks).toBeUndefined();

    const off = await repo.updateProject(id, { redirectChecks: false });
    expect(off.isOk() && off.value.redirectChecks).toBe(false);
    expect((await repo.getProject(id))?.redirectChecks).toBe(false);

    await repo.updateProject(id, { redirectChecks: true });
    expect((await repo.getProject(id))?.redirectChecks).toBeUndefined();
  });
});
