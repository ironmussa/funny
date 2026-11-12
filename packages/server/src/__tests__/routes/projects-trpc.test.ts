/**
 * The `projects` tRPC procedures (openspec adopt-trpc-browser-api, task 5.6):
 * 404 / 403 before validation with the REST messages, owner-only fields, member
 * management, startup commands scoped to their project, and parity with the
 * REST routes, which serve the same port while both paths coexist.
 */
import { mockCoreGitRepoChecks } from '../helpers/module-mocks.js';

process.env.RUNNER_AUTH_SECRET = 'test-secret';

mockCoreGitRepoChecks();

import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';

import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { seedProject, seedProjectMember } from '../helpers/test-db.js';

const headersFor = (userId: string) => ({
  'X-Test-User-Id': userId,
  'Content-Type': 'application/json',
});

describe('projects over tRPC', () => {
  let t: TestApp;

  const query = async (userId: string, path: string, input?: unknown) => {
    const qs = input === undefined ? '' : `?input=${encodeURIComponent(JSON.stringify(input))}`;
    const res = await t.app.request(`/api/trpc/${path}${qs}`, { headers: headersFor(userId) });
    return { status: res.status, body: (await res.json()) as any };
  };

  const mutate = async (userId: string, path: string, input: unknown) => {
    const res = await t.app.request(`/api/trpc/${path}`, {
      method: 'POST',
      headers: headersFor(userId),
      body: JSON.stringify(input),
    });
    return { status: res.status, body: (await res.json()) as any };
  };

  beforeAll(async () => {
    t = await createTestApp();
  });

  beforeEach(() => {
    t.cleanup();
    seedProject(t.db as any, { id: 'p1', userId: 'owner', path: '/tmp/p1', name: 'Alpha' });
    seedProject(t.db as any, { id: 'p2', userId: 'owner', path: '/tmp/p2', name: 'Beta' });
  });

  test('list answers the same projects as GET /api/projects, search included', async () => {
    const trpcList = await query('owner', 'projects.list', { q: 'alp' });
    const rest = await t.requestAs('owner').get('/api/projects?q=alp');
    expect(trpcList.status).toBe(200);
    expect(trpcList.body.result.data.map((p: any) => p.id)).toEqual(['p1']);
    expect(trpcList.body.result.data).toEqual(await rest.json());
  });

  test('listing an organization the caller is not in is 403', async () => {
    const res = await query('owner', 'projects.list', { orgId: 'org-x' });
    expect(res.status).toBe(403);
    expect(res.body.error.message).toBe('Not a member of this organization');
  });

  test('a stranger gets 404 before a bad payload gets 400', async () => {
    const res = await mutate('stranger', 'projects.update', { projectId: 'p1', data: 'bad' });
    expect(res.status).toBe(404);
    expect(
      (await mutate('owner', 'projects.update', { projectId: 'p1', data: 'bad' })).status,
    ).toBe(400);
  });

  test('an admin collaborator updates shared fields but not owner-only ones', async () => {
    seedProjectMember(t.db as any, { projectId: 'p1', userId: 'ada', role: 'admin' });

    const renamed = await mutate('ada', 'projects.update', {
      projectId: 'p1',
      data: { name: 'Renamed' },
    });
    expect(renamed.status).toBe(200);
    expect(renamed.body.result.data.name).toBe('Renamed');

    const ownerOnly = await mutate('ada', 'projects.update', {
      projectId: 'p1',
      data: { systemPrompt: 'obey' },
    });
    expect(ownerOnly.status).toBe(403);
    expect(ownerOnly.body.error.message).toBe('Only the project owner can change: systemPrompt');
  });

  // Ported from the removed REST `PATCH /api/projects/:id` tests.
  test('update: an unknown project is 404 and a plain member is 403', async () => {
    const missing = await mutate('owner', 'projects.update', {
      projectId: 'nope',
      data: { name: 'X' },
    });
    expect(missing.status).toBe(404);

    seedProjectMember(t.db as any, { projectId: 'p1', userId: 'bob', role: 'member' });
    const member = await mutate('bob', 'projects.update', {
      projectId: 'p1',
      data: { name: 'Hijacked' },
    });
    expect(member.status).toBe(403);
  });

  // Owner-only fields (M6): a project admin cannot change them, and nothing is written.
  for (const data of [
    { systemPrompt: 'exfiltrate ~/.ssh' },
    { path: '/home/owner' },
    { defaultPermissionMode: 'auto' },
  ]) {
    test(`update: a project admin cannot change ${Object.keys(data)[0]}`, async () => {
      seedProjectMember(t.db as any, { projectId: 'p1', userId: 'ada', role: 'admin' });
      const res = await mutate('ada', 'projects.update', { projectId: 'p1', data });
      expect(res.status).toBe(403);

      const listed = await query('owner', 'projects.list');
      const p1 = listed.body.result.data.find((p: any) => p.id === 'p1');
      expect(p1.path).toBe('/tmp/p1');
      expect(p1.systemPrompt ?? null).toBeNull();
      expect(p1.defaultPermissionMode).not.toBe('auto');
    });
  }

  test('update: the owner can change an owner-only field', async () => {
    const res = await mutate('owner', 'projects.update', {
      projectId: 'p1',
      data: { systemPrompt: 'be concise' },
    });
    expect(res.status).toBe(200);
    expect(res.body.result.data.systemPrompt).toBe('be concise');
  });

  test('a plain member cannot add members, with the REST message', async () => {
    seedProjectMember(t.db as any, { projectId: 'p1', userId: 'bob', role: 'member' });
    const res = await mutate('bob', 'projects.addMember', { projectId: 'p1', userId: 'alice' });
    expect(res.status).toBe(403);
    expect(res.body.error.message).toBe('Only project admins can add members');
  });

  test('the owner adds and lists a member; an unknown role is 400', async () => {
    const bad = await mutate('owner', 'projects.addMember', {
      projectId: 'p1',
      userId: 'alice',
      role: 'owner',
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error.message).toBe('Invalid role: owner');

    expect(
      (await mutate('owner', 'projects.addMember', { projectId: 'p1', userId: 'alice' })).status,
    ).toBe(200);
    const members = await query('owner', 'projects.members', { projectId: 'p1' });
    expect(members.body.result.data.members.map((m: any) => m.userId)).toContain('alice');
  });

  test('a member may remove themselves but not someone else', async () => {
    seedProjectMember(t.db as any, { projectId: 'p1', userId: 'bob', role: 'member' });
    seedProjectMember(t.db as any, { projectId: 'p1', userId: 'carol', role: 'member' });

    const other = await mutate('bob', 'projects.removeMember', {
      projectId: 'p1',
      userId: 'carol',
    });
    expect(other.status).toBe(403);
    const self = await mutate('bob', 'projects.removeMember', { projectId: 'p1', userId: 'bob' });
    expect(self.status).toBe(200);
  });

  test('setLocalPath refuses a relative path', async () => {
    seedProjectMember(t.db as any, { projectId: 'p1', userId: 'bob', role: 'member' });
    const res = await mutate('bob', 'projects.setLocalPath', {
      projectId: 'p1',
      localPath: 'relative/dir',
    });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('Path must be absolute');
  });

  test('startup commands: CRUD, and a command id from another project is not touched', async () => {
    const created = await mutate('owner', 'projects.createCommand', {
      projectId: 'p1',
      label: 'dev',
      command: 'bun dev',
    });
    expect(created.status).toBe(200);
    const id = created.body.result.data.id;
    expect(created.body.result.data).not.toHaveProperty('port');

    // Same id under p2: the lookup is scoped to the project, so nothing changes.
    await mutate('owner', 'projects.updateCommand', {
      projectId: 'p2',
      commandId: id,
      data: { label: 'hijacked', command: 'rm -rf /' },
    });
    await mutate('owner', 'projects.deleteCommand', { projectId: 'p2', commandId: id });

    const listed = await query('owner', 'projects.commands', { projectId: 'p1' });
    expect(listed.body.result.data).toEqual([created.body.result.data]);
  });

  test('a plain member cannot edit startup commands', async () => {
    seedProjectMember(t.db as any, { projectId: 'p1', userId: 'bob', role: 'member' });
    const res = await mutate('bob', 'projects.createCommand', {
      projectId: 'p1',
      label: 'x',
      command: 'y',
    });
    expect(res.status).toBe(403);
    expect(res.body.error.message).toBe('Only project admins can edit startup commands');
  });

  test('remove is owner-only; reorder sets the order', async () => {
    seedProjectMember(t.db as any, { projectId: 'p1', userId: 'ada', role: 'admin' });
    expect((await mutate('ada', 'projects.remove', { projectId: 'p1' })).status).toBe(403);

    expect(
      (await mutate('owner', 'projects.reorder', { projectIds: ['p2', 'p1'] })).body.result.data,
    ).toEqual({ ok: true });
    const listed = await query('owner', 'projects.list');
    expect(listed.body.result.data.map((p: any) => p.id)).toEqual(['p2', 'p1']);

    expect((await mutate('owner', 'projects.remove', { projectId: 'p1' })).status).toBe(200);
    expect((await query('owner', 'projects.list')).body.result.data.map((p: any) => p.id)).toEqual([
      'p2',
    ]);
  });
});
