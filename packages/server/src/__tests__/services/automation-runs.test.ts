/** Automation run completion from the persisted terminal thread status. */
import { describe, test, expect, beforeAll, beforeEach } from 'bun:test';

import { eq } from 'drizzle-orm';

import * as schema from '../../db/schema.js';
import { onAutomationThreadTerminal } from '../../services/automation-runs.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { seedAutomation, seedMessage, seedProject, seedThread } from '../helpers/test-db.js';

describe('onAutomationThreadTerminal', () => {
  let t: TestApp;
  const run = (id: string) =>
    (t.db as any)
      .select()
      .from(schema.automationRuns)
      .where(eq(schema.automationRuns.id, id))
      .get();
  const thread = (id: string) =>
    (t.db as any).select().from(schema.threads).where(eq(schema.threads.id, id)).get();

  function seedRun(id: string, threadId: string, status = 'running', startedAt?: string) {
    seedThread(t.db as any, { id: threadId, projectId: 'p1', userId: 'alice' });
    (t.db as any)
      .insert(schema.automationRuns)
      .values({
        id,
        automationId: 'a',
        threadId,
        status,
        startedAt: startedAt ?? new Date().toISOString(),
      })
      .run();
  }

  beforeAll(async () => {
    t = await createTestApp();
  });

  beforeEach(() => {
    t.cleanup();
    seedProject(t.db as any, { id: 'p1', userId: 'alice', path: '/repo' });
    seedAutomation(t.db as any, { id: 'a', projectId: 'p1', userId: 'alice' });
  });

  test('completed → completed with findings and a summary from the last reply, pending review', async () => {
    seedRun('r1', 't1');
    seedMessage(
      t.db as any,
      {
        threadId: 't1',
        role: 'assistant',
        content: 'first',
        timestamp: '2026-01-01T00:00:00Z',
      } as any,
    );
    seedMessage(
      t.db as any,
      {
        id: 'm2',
        threadId: 't1',
        role: 'assistant',
        content: 'Found 2 issues',
        timestamp: '2026-01-01T00:01:00Z',
      } as any,
    );

    await onAutomationThreadTerminal('t1', 'completed');

    expect(run('r1')).toMatchObject({
      status: 'completed',
      hasFindings: 1,
      summary: 'Found 2 issues',
      triageStatus: 'pending',
    });
    expect(run('r1').completedAt).not.toBeNull();
  });

  test.each(['failed', 'stopped', 'interrupted'])(
    '%s → failed and still visible',
    async (status) => {
      seedRun('r1', 't1');

      await onAutomationThreadTerminal('t1', status);

      expect(run('r1')).toMatchObject({
        status: 'failed',
        hasFindings: 0,
        triageStatus: 'pending',
      });
    },
  );

  test('a second terminal update is a no-op', async () => {
    seedRun('r1', 't1');
    await onAutomationThreadTerminal('t1', 'completed');
    const first = run('r1');

    await onAutomationThreadTerminal('t1', 'failed');

    expect(run('r1')).toEqual(first);
  });

  test('a thread that is not an automation run is ignored', async () => {
    seedThread(t.db as any, { id: 'plain', projectId: 'p1', userId: 'alice' });

    await onAutomationThreadTerminal('plain', 'completed');

    expect((t.db as any).select().from(schema.automationRuns).all()).toEqual([]);
  });

  test('threads of finished runs beyond maxRunHistory are archived', async () => {
    (t.db as any).update(schema.automations).set({ maxRunHistory: 2 }).run();
    seedRun('r-old', 't-old', 'completed', '2026-01-01T00:00:00Z');
    seedRun('r-mid', 't-mid', 'completed', '2026-01-02T00:00:00Z');
    seedRun('r-new', 't-new', 'running', '2026-01-03T00:00:00Z');

    await onAutomationThreadTerminal('t-new', 'completed');

    expect(thread('t-old').archived).toBe(1);
    expect(thread('t-mid').archived).toBe(0);
    expect(thread('t-new').archived).toBe(0);
  });
});
