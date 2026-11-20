/**
 * `projects.myRole`: the caller's effective role on a project, resolved by the
 * same `projectRole` the server authorizes with, so the client can hide what it
 * would refuse (e.g. the runtime and factory settings for a viewer).
 */
import { mockCoreGitRepoChecks } from '../helpers/module-mocks.js';

process.env.RUNNER_AUTH_SECRET = 'test-secret';

mockCoreGitRepoChecks();

import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';

import { seedProject, seedProjectMember } from '../helpers/builders-routes.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';

describe('projects.myRole over tRPC', () => {
  let t: TestApp;

  const myRole = async (userId: string, projectId: string) => {
    const qs = `?input=${encodeURIComponent(JSON.stringify({ projectId }))}`;
    const res = await t.app.request(`/api/trpc/projects.myRole${qs}`, {
      headers: { 'X-Test-User-Id': userId },
    });
    return { status: res.status, role: (await res.json()).result?.data?.role };
  };

  beforeAll(async () => {
    t = await createTestApp({ userId: 'alice' });
  });

  beforeEach(() => {
    t.cleanup();
    seedProject(t.db, { id: 'p1', userId: 'alice', path: '/repo-a' });
    seedProjectMember(t.db, { projectId: 'p1', userId: 'bob', role: 'member' });
    seedProjectMember(t.db, { projectId: 'p1', userId: 'vic', role: 'viewer' });
  });

  test('owner, contributor and viewer each get their role; an outsider gets 404', async () => {
    expect(await myRole('alice', 'p1')).toEqual({ status: 200, role: 'owner' });
    expect(await myRole('bob', 'p1')).toEqual({ status: 200, role: 'contributor' });
    expect(await myRole('vic', 'p1')).toEqual({ status: 200, role: 'viewer' });
    expect((await myRole('carol', 'p1')).status).toBe(404);
  });
});
