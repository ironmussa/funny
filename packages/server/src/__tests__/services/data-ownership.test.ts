/**
 * Characterization tests for the runner → server data-plane ownership guard.
 * Every branch asserts the exact verdict (and refusal reason) so a refactor of
 * `assertDataOwnership` cannot silently change tenant-isolation semantics.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';

import { assertDataOwnership } from '../../services/data-ownership.js';
import {
  seedMessage,
  seedMessageQueue,
  seedProject,
  seedProjectMember,
  seedThread,
  seedToolCall,
} from '../helpers/test-db.js';

const OK = { ok: true as const };
const deny = (reason: string) => ({ ok: false as const, reason });

describe('assertDataOwnership', () => {
  let db: (typeof import('../../db/index.js'))['db'];
  let schema: typeof import('../../db/schema.js');

  beforeAll(async () => {
    const { initDatabase } = await import('../../db/index.js');
    await initDatabase({ sqlitePath: ':memory:' });
    const { autoMigrate } = await import('../../db/migrate.js');
    await autoMigrate();
    db = (await import('../../db/index.js')).db;
    schema = await import('../../db/schema.js');
  });

  beforeEach(() => {
    for (const table of [
      'pending_permission_requests',
      'watchers',
      'jobs',
      'tool_calls',
      'messages',
      'message_queue',
      'threads',
      'project_members',
      'projects',
    ]) {
      try {
        (db as any).run(`DELETE FROM ${table}`);
      } catch {
        // ignore
      }
    }
    seedProject(db as any, { id: 'p1', userId: 'u1', path: '/tmp/p1' });
    seedProject(db as any, { id: 'p2', userId: 'u2', path: '/tmp/p2' });
    seedThread(db as any, { id: 't1', projectId: 'p1', userId: 'u1' });
    seedThread(db as any, { id: 't2', projectId: 'p2', userId: 'u2' });
    seedMessage(db as any, { id: 'm1', threadId: 't1' });
    seedMessage(db as any, { id: 'm2', threadId: 't2' });
    seedToolCall(db as any, { id: 'tc1', messageId: 'm1' });
    seedToolCall(db as any, { id: 'tc2', messageId: 'm2' });
    seedMessageQueue(db as any, { id: 'q1', threadId: 't1' });
    seedMessageQueue(db as any, { id: 'q2', threadId: 't2' });
  });

  afterAll(async () => {
    const { closeDatabase } = await import('../../db/index.js');
    await closeDatabase?.();
  });

  const check = (data: any, user: string | null = 'u1') => assertDataOwnership(user, data);

  describe('user-neutral and ownerless runners', () => {
    test('user-neutral types pass even without an owning user', async () => {
      expect(await check({ type: 'data:get_agent_template', templateId: 'x' }, null)).toEqual(OK);
      expect(await check({ type: 'data:mark_and_list_stale_threads' }, null)).toEqual(OK);
    });

    test('user-neutral types skip entity checks', async () => {
      expect(await check({ type: 'data:get_agent_template', threadId: 't2' })).toEqual(OK);
    });

    test('other types require an owning user', async () => {
      expect(await check({ type: 'data:get_thread', threadId: 't1' }, null)).toEqual(
        deny('runner has no owning user'),
      );
      expect(await check({ type: 'data:anything' }, null)).toEqual(
        deny('runner has no owning user'),
      );
    });

    test('null / undefined data with an owner passes', async () => {
      expect(await check(undefined)).toEqual(OK);
      expect(await check(null)).toEqual(OK);
      expect(await check({})).toEqual(OK);
    });
  });

  describe('explicit userId', () => {
    test('top-level userId mismatch is refused', async () => {
      expect(await check({ type: 'data:get_profile', userId: 'u2' })).toEqual(
        deny('userId u2 !== runner u1'),
      );
    });

    test('top-level userId match passes', async () => {
      expect(await check({ type: 'data:get_profile', userId: 'u1' })).toEqual(OK);
    });

    test('empty top-level userId is ignored', async () => {
      expect(await check({ type: 'data:get_profile', userId: '' })).toEqual(OK);
    });

    test('payload.userId is only honored on create_thread', async () => {
      expect(await check({ type: 'data:create_thread', payload: { userId: 'u2' } })).toEqual(
        deny('userId u2 !== runner u1'),
      );
      expect(await check({ type: 'data:update_profile', payload: { userId: 'u2' } })).toEqual(OK);
    });

    test('top-level userId takes precedence over create_thread payload.userId', async () => {
      expect(
        await check({ type: 'data:create_thread', userId: 'u1', payload: { userId: 'u2' } }),
      ).toEqual(OK);
    });
  });

  describe('thread ownership', () => {
    test('owned thread via top-level threadId passes', async () => {
      expect(await check({ type: 'data:get_thread', threadId: 't1' })).toEqual(OK);
    });

    test('foreign thread via top-level threadId is refused', async () => {
      expect(await check({ type: 'data:get_thread', threadId: 't2' })).toEqual(
        deny('thread t2 owned by u2'),
      );
    });

    test('foreign thread via payload.threadId is refused', async () => {
      expect(await check({ type: 'data:update_thread', payload: { threadId: 't2' } })).toEqual(
        deny('thread t2 owned by u2'),
      );
    });

    test('top-level threadId wins over payload.threadId', async () => {
      expect(
        await check({ type: 'data:update_thread', threadId: 't1', payload: { threadId: 't2' } }),
      ).toEqual(OK);
    });

    test('missing thread is refused', async () => {
      expect(await check({ type: 'data:get_thread', threadId: 'nope' })).toEqual(
        deny('thread nope not found'),
      );
    });
  });

  describe('external request / session lookups', () => {
    beforeEach(async () => {
      await db
        .update(schema.threads)
        .set({ externalRequestId: 'ext-2', sessionId: 'sess-2' } as any)
        .where((await import('drizzle-orm')).eq(schema.threads.id, 't2'));
      await db
        .update(schema.threads)
        .set({ externalRequestId: 'ext-1', sessionId: 'sess-1' } as any)
        .where((await import('drizzle-orm')).eq(schema.threads.id, 't1'));
    });

    test('external request id of another user is refused', async () => {
      expect(
        await check({ type: 'data:get_thread_by_external_request_id', externalRequestId: 'ext-2' }),
      ).toEqual(deny('external request ext-2 owned by u2'));
    });

    test('external request id owned or missing passes', async () => {
      for (const id of ['ext-1', 'missing']) {
        expect(
          await check({ type: 'data:get_thread_by_external_request_id', externalRequestId: id }),
        ).toEqual(OK);
      }
    });

    test('external request id is only checked for its own type', async () => {
      expect(await check({ type: 'data:get_thread', externalRequestId: 'ext-2' })).toEqual(OK);
    });

    test('session id of another user is refused', async () => {
      expect(await check({ type: 'data:get_thread_by_session_id', sessionId: 'sess-2' })).toEqual(
        deny('session sess-2 owned by u2'),
      );
    });

    test('session id owned or missing passes; other types ignore it', async () => {
      expect(await check({ type: 'data:get_thread_by_session_id', sessionId: 'sess-1' })).toEqual(
        OK,
      );
      expect(await check({ type: 'data:get_thread_by_session_id', sessionId: 'zz' })).toEqual(OK);
      expect(await check({ type: 'data:get_thread', sessionId: 'sess-2' })).toEqual(OK);
    });
  });

  describe('project ownership', () => {
    test('owned project passes (top-level and payload)', async () => {
      expect(await check({ type: 'data:get_project', projectId: 'p1' })).toEqual(OK);
      expect(await check({ type: 'data:x', payload: { projectId: 'p1' } })).toEqual(OK);
    });

    test('foreign project is refused', async () => {
      expect(await check({ type: 'data:get_project', projectId: 'p2' })).toEqual(
        deny('project p2 owned by u2'),
      );
      expect(await check({ type: 'data:x', payload: { projectId: 'p2' } })).toEqual(
        deny('project p2 owned by u2'),
      );
    });

    test('foreign project passes for a project member', async () => {
      seedProjectMember(db as any, { projectId: 'p2', userId: 'u1' });
      expect(await check({ type: 'data:get_project', projectId: 'p2' })).toEqual(OK);
    });

    test('missing project is refused', async () => {
      expect(await check({ type: 'data:get_project', projectId: 'nope' })).toEqual(
        deny('project nope not found'),
      );
    });

    test('thread check runs before project check', async () => {
      expect(await check({ type: 'data:x', threadId: 't2', projectId: 'nope' })).toEqual(
        deny('thread t2 owned by u2'),
      );
    });
  });

  describe('message ownership for tool calls', () => {
    for (const type of ['data:find_tool_call', 'data:insert_tool_call']) {
      test(`${type}: foreign message is refused`, async () => {
        expect(await check({ type, payload: { messageId: 'm2' } })).toEqual(
          deny('message m2 cross-tenant'),
        );
      });
      test(`${type}: owned or missing message passes`, async () => {
        expect(await check({ type, payload: { messageId: 'm1' } })).toEqual(OK);
        expect(await check({ type, payload: { messageId: 'missing' } })).toEqual(OK);
      });
    }

    test('other types ignore payload.messageId', async () => {
      expect(await check({ type: 'data:x', payload: { messageId: 'm2' } })).toEqual(OK);
    });
  });

  describe('update_message', () => {
    test('owned message passes', async () => {
      expect(await check({ type: 'data:update_message', payload: { messageId: 'm1' } })).toEqual(
        OK,
      );
    });
    test('foreign message is refused', async () => {
      expect(await check({ type: 'data:update_message', payload: { messageId: 'm2' } })).toEqual(
        deny('message m2 cross-tenant'),
      );
    });
    test('missing message is refused', async () => {
      expect(await check({ type: 'data:update_message', payload: { messageId: 'zz' } })).toEqual(
        deny('message zz not found'),
      );
    });
    test('non-string messageId is skipped', async () => {
      expect(await check({ type: 'data:update_message', payload: { messageId: 5 } })).toEqual(OK);
    });
  });

  describe('tool call ownership', () => {
    test('get_tool_call: owned passes, foreign/missing refused', async () => {
      expect(await check({ type: 'data:get_tool_call', toolCallId: 'tc1' })).toEqual(OK);
      expect(await check({ type: 'data:get_tool_call', toolCallId: 'tc2' })).toEqual(
        deny('tool call tc2 cross-tenant'),
      );
      expect(await check({ type: 'data:get_tool_call', toolCallId: 'zz' })).toEqual(
        deny('tool call zz not found'),
      );
    });

    test('update_tool_call_output: owned passes, foreign/missing refused', async () => {
      const t = 'data:update_tool_call_output';
      expect(await check({ type: t, payload: { toolCallId: 'tc1' } })).toEqual(OK);
      expect(await check({ type: t, payload: { toolCallId: 'tc2' } })).toEqual(
        deny('tool call tc2 cross-tenant'),
      );
      expect(await check({ type: t, payload: { toolCallId: 'zz' } })).toEqual(
        deny('tool call zz not found'),
      );
    });

    test('orphaned tool call is refused', async () => {
      (db as any).run('PRAGMA foreign_keys = OFF');
      try {
        seedToolCall(db as any, { id: 'tc-orphan', messageId: 'no-such-message' });
      } finally {
        (db as any).run('PRAGMA foreign_keys = ON');
      }
      expect(await check({ type: 'data:get_tool_call', toolCallId: 'tc-orphan' })).toEqual(
        deny('tool call tc-orphan orphaned'),
      );
    });

    test('tool call ids are only read from their own type/location', async () => {
      expect(await check({ type: 'data:get_tool_call', payload: { toolCallId: 'tc2' } })).toEqual(
        OK,
      );
      expect(await check({ type: 'data:update_tool_call_output', toolCallId: 'tc2' })).toEqual(OK);
      expect(await check({ type: 'data:x', toolCallId: 'tc2' })).toEqual(OK);
    });
  });

  describe('queued message ownership', () => {
    for (const type of ['data:cancel_queued_message', 'data:update_queued_message']) {
      test(`${type}: owned passes, foreign/missing refused`, async () => {
        expect(await check({ type, messageId: 'q1' })).toEqual(OK);
        expect(await check({ type, messageId: 'q2' })).toEqual(
          deny('queued message q2 cross-tenant'),
        );
        expect(await check({ type, messageId: 'zz' })).toEqual(deny('queued message zz not found'));
      });
    }
    test('other types ignore top-level messageId', async () => {
      expect(await check({ type: 'data:x', messageId: 'q2' })).toEqual(OK);
    });
  });

  describe('watcher and job ownership', () => {
    beforeEach(async () => {
      const now = new Date().toISOString();
      for (const [id, threadId, userId] of [
        ['w1', 't1', 'u1'],
        ['w2', 't2', 'u2'],
      ]) {
        await db.insert(schema.watchers).values({
          id,
          threadId,
          userId,
          key: id,
          label: id,
          nextWakeAt: 0,
          createdAt: now,
          updatedAt: now,
        } as any);
        await db.insert(schema.jobs).values({
          id: id.replace('w', 'j'),
          threadId,
          userId,
          command: 'true',
          logPath: '/tmp/l',
          exitPath: '/tmp/e',
          startedAt: now,
          updatedAt: now,
        } as any);
      }
    });

    for (const [kind, prefix, types] of [
      ['watcher', 'w', ['data:watcher_update', 'data:watcher_get']],
      ['job', 'j', ['data:job_update', 'data:job_get']],
    ] as const) {
      for (const type of types) {
        test(`${type}: owned passes, foreign/missing refused`, async () => {
          expect(await check({ type, payload: { id: `${prefix}1` } })).toEqual(OK);
          expect(await check({ type, payload: { id: `${prefix}2` } })).toEqual(
            deny(`${kind} ${prefix}2 cross-tenant`),
          );
          expect(await check({ type, payload: { id: 'zz' } })).toEqual(
            deny(`${kind} zz not found`),
          );
        });
      }
    }

    test('other types ignore payload.id', async () => {
      expect(await check({ type: 'data:watcher_insert', payload: { id: 'w2' } })).toEqual(OK);
      expect(await check({ type: 'data:job_insert', payload: { id: 'j2' } })).toEqual(OK);
    });
  });

  describe('pending permission ownership', () => {
    beforeEach(async () => {
      for (const [requestId, threadId] of [
        ['perm-1', 't1'],
        ['perm-2', 't2'],
      ]) {
        await db.insert(schema.pendingPermissionRequests).values({
          requestId,
          threadId,
          runId: 'run',
          transport: 'codex-acp',
          toolCallId: 'tool',
          toolName: 'Write',
          canAlwaysAllow: 0,
          canDeny: 1,
          status: 'active',
          createdAt: new Date().toISOString(),
        });
      }
    });

    for (const type of [
      'data:resolve_pending_permission_request',
      'data:expire_pending_permission_request',
    ]) {
      test(`${type}: owned passes, foreign/missing refused`, async () => {
        expect(await check({ type, payload: { requestId: 'perm-1' } })).toEqual(OK);
        expect(await check({ type, payload: { requestId: 'perm-2' } })).toEqual(
          deny('permission request cross-tenant'),
        );
        expect(await check({ type, payload: { requestId: 'zz' } })).toEqual(
          deny('permission request not found'),
        );
      });
    }

    test('other types ignore payload.requestId', async () => {
      expect(
        await check({
          type: 'data:create_pending_permission_request',
          payload: { requestId: 'perm-2' },
        }),
      ).toEqual(OK);
    });
  });
});
