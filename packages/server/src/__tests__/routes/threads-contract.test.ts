/**
 * The `threads` tRPC procedures answer the shared contract types
 * (`@funny/shared/contracts/threads`), not the raw `threads` row: booleans
 * instead of 0/1, `''` for a scratch thread's project, optional fields absent
 * instead of null, and server-internal columns left out.
 */

process.env.RUNNER_AUTH_SECRET = 'test-secret';

import { describe, test, expect, beforeAll, beforeEach } from 'bun:test';

import { eq } from 'drizzle-orm';

import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { seedMessage, seedProject, seedThread } from '../helpers/test-db.js';
import { threadProcedures } from '../helpers/thread-procedures.js';

/** Columns the server keeps to itself; the detail view exposes `initInfo` instead. */
const INTERNAL_COLUMNS = ['initTools', 'initCwd', 'initSlashCommands', 'runnerId', 'mergedAt'];

describe('Thread routes follow the contract', () => {
  let t: TestApp;

  const threads = (userId = 'user-1') => threadProcedures(t, userId);

  beforeAll(async () => {
    t = await createTestApp();
  });

  beforeEach(() => {
    t.cleanup();
    seedProject(t.db as any, { id: 'p1', userId: 'user-1', path: '/a' });
  });

  describe('thread shape', () => {
    test('a listed thread has boolean flags and no null fields', async () => {
      seedThread(t.db as any, {
        id: 't1',
        projectId: 'p1',
        userId: 'user-1',
        pinned: 1,
        schedulerManaged: 0,
        mergedAt: '2026-11-01T00:00:00.000Z',
      });

      const res = await threads().query('list', { projectId: 'p1' });
      expect(res.status).toBe(200);
      const [thread] = res.data.threads;

      expect(thread).toMatchObject({
        id: 't1',
        projectId: 'p1',
        isScratch: false,
        archived: false,
        pinned: true,
        schedulerManaged: false,
        fileCheckpointingEnabled: false,
        commentCount: 0,
      });
      expect(thread).not.toHaveProperty('branch');
      expect(thread).not.toHaveProperty('completedAt');
      for (const column of INTERNAL_COLUMNS) expect(thread).not.toHaveProperty(column);
      // `contextRecoveryReason` and the agent-profile fields are declared nullable.
      const nullable = [
        'contextRecoveryReason',
        'agentProfileId',
        'agentProfileName',
        'agentProfileProvider',
      ];
      for (const [key, value] of Object.entries(thread)) {
        if (!nullable.includes(key)) expect({ key, value }).not.toEqual({ key, value: null });
      }
    });

    test('a scratch thread has an empty projectId, not null', async () => {
      seedThread(t.db as any, { id: 's1', projectId: null, userId: 'user-1', isScratch: 1 });

      const res = await threads().query('scratch');
      const [thread] = res.data.threads;
      expect(thread).toMatchObject({ id: 's1', projectId: '', isScratch: true });
    });

    test('template variables arrive parsed, not as JSON text', async () => {
      seedThread(t.db as any, {
        id: 't1',
        projectId: 'p1',
        userId: 'user-1',
        templateVariables: JSON.stringify({ ticket: 'ABC-1' }),
      });

      const res = await threads().query('get', { id: 't1' });
      expect(res.data.templateVariables).toEqual({ ticket: 'ABC-1' });
    });

    test('the detail view keeps its message window and initInfo, without the raw init columns', async () => {
      seedThread(t.db as any, {
        id: 't1',
        projectId: 'p1',
        userId: 'user-1',
        archived: 1,
        initTools: JSON.stringify(['Read']),
        initCwd: '/a',
        initSlashCommands: JSON.stringify(['/review']),
      });

      const res = await threads().query('get', { id: 't1' });
      expect(res.status).toBe(200);
      const body = res.data;

      expect(body.archived).toBe(true);
      expect(body.messages).toEqual([]);
      expect(body.initInfo).toMatchObject({
        tools: ['Read'],
        cwd: '/a',
        slashCommands: ['/review'],
      });
      expect(body.viewerShareLevel).toBeNull();
      for (const column of INTERNAL_COLUMNS) expect(body).not.toHaveProperty(column);
    });

    test('an archived listing maps its threads too', async () => {
      seedThread(t.db as any, { id: 't1', projectId: 'p1', userId: 'user-1', archived: 1 });

      const body = (await threads().query('archived')).data;
      expect(body).toMatchObject({ total: 1, page: 1, limit: 100 });
      expect(body.threads[0].archived).toBe(true);
    });
  });

  describe('list paging', () => {
    test('clamps an out-of-range limit instead of refusing it', async () => {
      seedThread(t.db as any, { id: 't1', projectId: 'p1', userId: 'user-1' });

      const res = await threads().query('list', { projectId: 'p1', limit: '5000', offset: '-3' });
      expect(res.status).toBe(200);
      expect(res.data.threads).toHaveLength(1);
    });

    test('falls back to the default page size for an unparsable limit', async () => {
      seedThread(t.db as any, { id: 't1', projectId: 'p1', userId: 'user-1' });

      const res = await threads().query('list', { projectId: 'p1', limit: 'lots' });
      expect(res.status).toBe(200);
      expect(res.data.threads).toHaveLength(1);
    });
  });

  describe('update input', () => {
    test('refuses a value of the wrong type instead of writing it', async () => {
      seedThread(t.db as any, { id: 't1', projectId: 'p1', userId: 'user-1', title: 'Original' });

      for (const body of [
        { title: 123 },
        { archived: 'yes' },
        { status: 'not-a-status' },
        { mode: 'elsewhere' },
      ]) {
        const res = await threads().mutate('update', { id: 't1', data: body });
        expect({ body, status: res.status }).toEqual({ body, status: 400 });
      }

      const [row] = await t.db.select().from(t.schema.threads).where(eq(t.schema.threads.id, 't1'));
      expect(row).toMatchObject({ title: 'Original', archived: 0, status: 'pending' });
    });

    test('still ignores keys outside the allow-list', async () => {
      seedThread(t.db as any, { id: 't1', projectId: 'p1', userId: 'user-1' });

      const res = await threads().mutate('update', {
        id: 't1',
        data: { title: 'Renamed', userId: 'user-2', cost: 99 },
      });
      expect(res.status).toBe(200);
      expect(res.data).toMatchObject({ title: 'Renamed', userId: 'user-1', cost: 0 });
    });

    test('answers 404 for someone else’s thread before looking at the body', async () => {
      seedThread(t.db as any, { id: 't1', projectId: 'p1', userId: 'user-2' });

      const res = await threads().mutate('update', { id: 't1', data: { title: 123 } });
      expect(res.status).toBe(404);
    });
  });

  describe('messages', () => {
    /** A message with every optional column null, and a legacy tool call with no input. */
    function seedSparseMessage() {
      seedThread(t.db as any, { id: 't1', projectId: 'p1', userId: 'user-1' });
      seedMessage(t.db as any, {
        id: 'm1',
        threadId: 't1',
        role: 'assistant',
        timestamp: '2026-11-01T00:00:00.000Z',
      });
      t.db
        .insert(t.schema.toolCalls)
        .values({ id: 'tc1', messageId: 'm1', name: 'Read', input: null })
        .run();
    }

    function expectContractMessage(message: Record<string, unknown>) {
      expect(message).toMatchObject({ id: 'm1', role: 'assistant' });
      for (const key of ['model', 'permissionMode', 'effort', 'author', 'images']) {
        expect(message).not.toHaveProperty(key);
      }
      const [toolCall] = message.toolCalls as Record<string, unknown>[];
      // `input` is a string the client JSON.parses; a missing one reads as no arguments.
      expect(toolCall).toEqual({ id: 'tc1', messageId: 'm1', name: 'Read', input: '{}' });
    }

    test('the detail view returns contract messages, not rows', async () => {
      seedSparseMessage();
      const body = (await threads().query('get', { id: 't1' })).data;
      expectContractMessage(body.messages[0]);
    });

    test('the paginated message window returns contract messages', async () => {
      seedSparseMessage();
      const res = await threads().query('messages', {
        id: 't1',
        cursor: '2027-01-01T00:00:00.000Z',
        limit: 'lots',
        direction: 'sideways',
      });
      expect(res.status).toBe(200);
      const body = res.data;
      // An unparsable limit and an unknown direction keep their old defaults (50, "before").
      expect(body.messages).toHaveLength(1);
      expectContractMessage(body.messages[0]);
    });
  });
});
