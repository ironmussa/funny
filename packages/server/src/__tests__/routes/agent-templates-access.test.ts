/**
 * Agent template read access: a template is visible to its owner, or to anyone
 * when `shared`. Another user's PRIVATE template must look missing (404) on
 * every by-id read path — GET /:id and POST /:id/duplicate — not just the list.
 */
import { describe, test, expect, beforeAll, beforeEach } from 'bun:test';

import { sql } from 'drizzle-orm';

import { createTestApp, type TestApp } from '../helpers/test-app.js';

describe('agent template access', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
    const { agentTemplateRoutes } = await import('../../routes/agent-templates.js');
    t.app.route('/api/agent-templates', agentTemplateRoutes);
  });

  beforeEach(() => {
    (t.db as any).run(sql`DELETE FROM agent_templates`);
    const now = new Date().toISOString();
    (t.db as any)
      .insert(t.schema.agentTemplates)
      .values([
        {
          id: 'tpl-private',
          userId: 'owner',
          name: 'Private',
          systemPrompt: 'owner secret prompt',
          shared: false,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: 'tpl-shared',
          userId: 'owner',
          name: 'Shared',
          shared: true,
          createdAt: now,
          updatedAt: now,
        },
      ])
      .run();
  });

  test("GET another user's private template → 404", async () => {
    const res = await t.requestAs('intruder').get('/api/agent-templates/tpl-private');
    expect(res.status).toBe(404);
  });

  test("duplicating another user's private template → 404 and nothing is copied", async () => {
    const res = await t.requestAs('intruder').post('/api/agent-templates/tpl-private/duplicate');
    expect(res.status).toBe(404);
    const list = (await (
      await t.requestAs('intruder').get('/api/agent-templates')
    ).json()) as any[];
    expect(list.map((r) => r.id)).toEqual(['tpl-shared']);
  });

  test('the owner can read and duplicate their private template', async () => {
    expect((await t.requestAs('owner').get('/api/agent-templates/tpl-private')).status).toBe(200);
    const dup = await t.requestAs('owner').post('/api/agent-templates/tpl-private/duplicate');
    expect(dup.status).toBe(201);
  });

  test('a shared template is readable and duplicable by others; the copy is private', async () => {
    expect((await t.requestAs('other').get('/api/agent-templates/tpl-shared')).status).toBe(200);
    const dup = await t.requestAs('other').post('/api/agent-templates/tpl-shared/duplicate');
    expect(dup.status).toBe(201);
    const copy = (await dup.json()) as { userId: string; shared: boolean };
    expect(copy.userId).toBe('other');
    expect(copy.shared).toBe(false);
  });
});
