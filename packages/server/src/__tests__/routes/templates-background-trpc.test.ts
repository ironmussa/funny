/**
 * The `agentTemplates`, `watchers` and `jobs` tRPC procedures (openspec
 * adopt-trpc-browser-api, task 5.4): read and write access, 404 / 403 before
 * validation, null columns as absent fields, and parity with the REST routes,
 * which serve the same ports while both paths coexist.
 */
import { mockCoreGitRepoChecks } from '../helpers/module-mocks.js';

process.env.RUNNER_AUTH_SECRET = 'test-secret';

mockCoreGitRepoChecks();

import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';

import { BUILTIN_AGENT_TEMPLATES } from '@funny/shared';
import { sql } from 'drizzle-orm';

import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { seedProject, seedThread } from '../helpers/test-db.js';

const headersFor = (userId: string) => ({
  'X-Test-User-Id': userId,
  'Content-Type': 'application/json',
});

describe('agent templates, watchers and jobs over tRPC', () => {
  let t: TestApp;
  const now = new Date().toISOString();

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
    const { agentTemplateRoutes } = await import('../../routes/agent-templates.js');
    const { watcherRoutes } = await import('../../routes/watchers.js');
    const { jobRoutes } = await import('../../routes/jobs.js');
    t.app.route('/api/agent-templates', agentTemplateRoutes);
    t.app.route('/api/watchers', watcherRoutes);
    t.app.route('/api/jobs', jobRoutes);
  });

  beforeEach(() => {
    t.cleanup();
    (t.db as any).run(sql`DELETE FROM agent_templates`);
    (t.db as any).run(sql`DELETE FROM watchers`);
    (t.db as any).run(sql`DELETE FROM jobs`);
    seedProject(t.db as any, { id: 'p1', userId: 'owner', path: '/tmp/p1' });
    seedThread(t.db as any, { id: 't1', projectId: 'p1', userId: 'owner' });
    (t.db as any)
      .insert(t.schema.agentTemplates)
      .values([
        {
          id: 'tpl-private',
          userId: 'owner',
          name: 'Private',
          shared: false,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: 'tpl-shared',
          userId: 'owner',
          name: 'Shared',
          shared: true,
          disallowedTools: JSON.stringify(['execute']),
          createdAt: now,
          updatedAt: now,
        },
      ])
      .run();
  });

  describe('agent templates', () => {
    test('a private template is visible to its owner only; null columns are absent', async () => {
      const own = await query('owner', 'agentTemplates.get', { id: 'tpl-private' });
      expect(own.status).toBe(200);
      expect(own.body.result.data).not.toHaveProperty('description');
      expect((await query('intruder', 'agentTemplates.get', { id: 'tpl-private' })).status).toBe(
        404,
      );

      const shared = await query('intruder', 'agentTemplates.get', { id: 'tpl-shared' });
      expect(shared.body.result.data.disallowedTools).toEqual(['execute']);

      const list = await query('intruder', 'agentTemplates.list');
      expect(list.body.result.data.map((x: any) => x.id)).toEqual(['tpl-shared']);
    });

    test('built-in templates can be read and duplicated into a private copy', async () => {
      const builtin = BUILTIN_AGENT_TEMPLATES[0];
      expect(
        (await query('anyone', 'agentTemplates.get', { id: builtin.id })).body.result.data.id,
      ).toBe(builtin.id);
      const copy = await mutate('anyone', 'agentTemplates.duplicate', { id: builtin.id });
      expect(copy.status).toBe(200);
      expect(copy.body.result.data).toMatchObject({
        userId: 'anyone',
        name: `${builtin.name} (copy)`,
        shared: false,
      });
    });

    test('duplicating a shared template gives a private copy; a private one looks absent', async () => {
      const copy = await mutate('intruder', 'agentTemplates.duplicate', { id: 'tpl-shared' });
      expect(copy.body.result.data).toMatchObject({ userId: 'intruder', shared: false });
      expect(
        (await mutate('intruder', 'agentTemplates.duplicate', { id: 'tpl-private' })).status,
      ).toBe(404);
    });

    test('only the owner writes: 404 / 403 come before the body is validated', async () => {
      expect(
        (
          await mutate('intruder', 'agentTemplates.update', {
            id: 'tpl-shared',
            data: { name: '' },
          })
        ).status,
      ).toBe(403);
      expect(
        (await mutate('owner', 'agentTemplates.update', { id: 'missing', data: { name: '' } }))
          .status,
      ).toBe(404);
      expect(
        (await mutate('owner', 'agentTemplates.update', { id: 'tpl-shared', data: { name: '' } }))
          .status,
      ).toBe(400);
      expect((await mutate('intruder', 'agentTemplates.remove', { id: 'tpl-shared' })).status).toBe(
        403,
      );

      const renamed = await mutate('owner', 'agentTemplates.update', {
        id: 'tpl-shared',
        data: { name: 'Renamed', customSkillPaths: ['/s'] },
      });
      expect(renamed.body.result.data).toMatchObject({ name: 'Renamed', customSkillPaths: ['/s'] });
      expect(
        (await mutate('owner', 'agentTemplates.remove', { id: 'tpl-shared' })).body.result.data,
      ).toEqual({ ok: true });
    });

    test('create validates the name and stores the list fields as JSON', async () => {
      expect((await mutate('u1', 'agentTemplates.create', { name: '' })).status).toBe(400);
      const created = await mutate('u1', 'agentTemplates.create', {
        name: 'New',
        disallowedTools: ['grep'],
      });
      expect(created.body.result.data).toMatchObject({
        name: 'New',
        systemPromptMode: 'prepend',
        disallowedTools: ['grep'],
        shared: false,
      });
    });
  });

  describe('watchers and jobs', () => {
    const watcher = (id: string, userId: string, status: string) => ({
      id,
      threadId: 't1',
      userId,
      key: id,
      label: id,
      nextWakeAt: 1,
      status,
      createdAt: now,
      updatedAt: now,
    });

    test('cancel stops a live watcher of the caller only; terminal ones stay', async () => {
      (t.db as any)
        .insert(t.schema.watchers)
        .values([watcher('w-live', 'owner', 'pending'), watcher('w-done', 'owner', 'done')])
        .run();

      expect((await mutate('intruder', 'watchers.cancel', { id: 'w-live' })).status).toBe(404);
      expect(
        (await mutate('owner', 'watchers.cancel', { id: 'w-live' })).body.result.data.status,
      ).toBe('cancelled');
      expect(
        (await mutate('owner', 'watchers.cancel', { id: 'w-done' })).body.result.data.status,
      ).toBe('done');
      expect((await query('intruder', 'watchers.list')).body.result.data).toEqual([]);
    });

    test('jobs.list returns only the caller’s jobs', async () => {
      (t.db as any)
        .insert(t.schema.jobs)
        .values({
          id: 'j1',
          threadId: 't1',
          userId: 'owner',
          command: 'sleep 1',
          logPath: '/tmp/j1.log',
          exitPath: '/tmp/j1.exit',
          startedAt: now,
          updatedAt: now,
        })
        .run();
      expect((await query('owner', 'jobs.list')).body.result.data.map((j: any) => j.id)).toEqual([
        'j1',
      ]);
      expect((await query('intruder', 'jobs.list')).body.result.data).toEqual([]);
    });
  });

  test('reads return the same data on REST and tRPC', async () => {
    (t.db as any).insert(t.schema.watchers).values(watcher0()).run();
    const rest = t.requestAs('owner');
    const pairs: Array<[string, string, unknown]> = [
      ['/api/agent-templates', 'agentTemplates.list', undefined],
      ['/api/agent-templates/tpl-shared', 'agentTemplates.get', { id: 'tpl-shared' }],
      ['/api/agent-templates/stats/usage', 'agentTemplates.usageStats', undefined],
      ['/api/watchers', 'watchers.list', undefined],
      ['/api/jobs', 'jobs.list', undefined],
    ];
    for (const [restPath, procedure, input] of pairs) {
      const restRes = await rest.get(restPath);
      const trpcRes = await query('owner', procedure, input);
      expect(trpcRes.status).toBe(restRes.status);
      expect(trpcRes.body.result.data).toEqual(await restRes.json());
    }

    function watcher0() {
      return {
        id: 'w0',
        threadId: 't1',
        userId: 'owner',
        key: 'k',
        label: 'l',
        nextWakeAt: 1,
        createdAt: now,
        updatedAt: now,
      };
    }
  });
});
