/**
 * Characterization tests for `assertRunnerDataScope` (project-runner-binding):
 * every way a data request can reference a thread — directly, or indirectly via
 * a message / tool call / queued message / watcher / job / pending permission
 * request / external request id / session id — and the exact decision + reason
 * returned. Pins the semantics so refactors of the lookup code stay identical.
 *
 * Fixture: `rx` is a dedicated runner pinned to project `px`; `laptop` is the
 * general runner (serves `py` and projectless work, but not the pinned `px`).
 * Entities suffixed `x` live in `px`, entities suffixed `y` live in `py`.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';

import * as schema from '../../db/schema.js';
import {
  __resetDataScopeCache,
  assertRunnerDataScope,
  type DataScopeDecision,
} from '../../services/data-scope.js';
import { __resetRunnerScopeCache, setProjectDedicatedRunner } from '../../services/runner-scope.js';
import {
  seedMessage,
  seedMessageQueue,
  seedProject,
  seedRunner,
  seedThread,
  seedToolCall,
} from '../helpers/test-db.js';

const OK: DataScopeDecision = { ok: true };
const OUT_PY: DataScopeDecision = { ok: false, reason: 'project py outside runner scope' };
const OUT_PX: DataScopeDecision = { ok: false, reason: 'project px outside runner scope' };
const OUT_SCRATCH: DataScopeDecision = {
  ok: false,
  reason: 'scratch thread outside runner scope',
};

/** Each builder produces a request that references the `x` or `y` entity. */
const REFERENCE_SHAPES: Array<[string, (s: 'x' | 'y') => any]> = [
  ['data.threadId', (s) => ({ type: 'data:get_thread', threadId: `t${s}` })],
  ['payload.threadId', (s) => ({ type: 'data:insert_message', payload: { threadId: `t${s}` } })],
  [
    'payload.row.threadId',
    (s) => ({ type: 'data:save_thread_event', payload: { row: { threadId: `t${s}` } } }),
  ],
  ['data.projectId', (s) => ({ type: 'data:get_project', projectId: `p${s}` })],
  [
    'payload.projectId',
    (s) => ({ type: 'data:list_project_threads', payload: { projectId: `p${s}` } }),
  ],
  [
    'external request id',
    (s) => ({ type: 'data:get_thread_by_external_request_id', externalRequestId: `ext-${s}` }),
  ],
  ['session id', (s) => ({ type: 'data:get_thread_by_session_id', sessionId: `sess-${s}` })],
  [
    'update_message payload.messageId',
    (s) => ({ type: 'data:update_message', payload: { messageId: `m${s}` } }),
  ],
  [
    'find_tool_call payload.messageId',
    (s) => ({ type: 'data:find_tool_call', payload: { messageId: `m${s}` } }),
  ],
  [
    'insert_tool_call payload.messageId',
    (s) => ({ type: 'data:insert_tool_call', payload: { messageId: `m${s}` } }),
  ],
  ['get_tool_call data.toolCallId', (s) => ({ type: 'data:get_tool_call', toolCallId: `tc${s}` })],
  [
    'update_tool_call_output payload.toolCallId',
    (s) => ({ type: 'data:update_tool_call_output', payload: { toolCallId: `tc${s}` } }),
  ],
  [
    'cancel_queued_message data.messageId',
    (s) => ({ type: 'data:cancel_queued_message', messageId: `q${s}` }),
  ],
  [
    'update_queued_message data.messageId',
    (s) => ({ type: 'data:update_queued_message', messageId: `q${s}` }),
  ],
  ['watcher_get payload.id', (s) => ({ type: 'data:watcher_get', payload: { id: `w${s}` } })],
  ['watcher_update payload.id', (s) => ({ type: 'data:watcher_update', payload: { id: `w${s}` } })],
  ['job_get payload.id', (s) => ({ type: 'data:job_get', payload: { id: `j${s}` } })],
  ['job_update payload.id', (s) => ({ type: 'data:job_update', payload: { id: `j${s}` } })],
  [
    'resolve_pending_permission_request payload.requestId',
    (s) => ({
      type: 'data:resolve_pending_permission_request',
      payload: { requestId: `pr${s}` },
    }),
  ],
  [
    'expire_pending_permission_request payload.requestId',
    (s) => ({
      type: 'data:expire_pending_permission_request',
      payload: { requestId: `pr${s}` },
    }),
  ],
  [
    'user rule with explicit projectId',
    (s) => ({ type: 'data:get_profile', userId: 'alice', projectId: `p${s}` }),
  ],
];

/** Reference fields that only count for specific types — elsewhere they are ignored. */
const IGNORED_REFERENCES: Array<[string, any]> = [
  [
    'get_tool_call reads data.toolCallId, not payload',
    {
      type: 'data:get_tool_call',
      payload: { toolCallId: 'tcy' },
    },
  ],
  [
    'update_tool_call_output reads payload.toolCallId, not data',
    {
      type: 'data:update_tool_call_output',
      toolCallId: 'tcy',
    },
  ],
  [
    'update_message reads payload.messageId, not data',
    {
      type: 'data:update_message',
      messageId: 'my',
    },
  ],
  [
    'get_thread does not resolve payload.messageId',
    {
      type: 'data:get_thread',
      payload: { messageId: 'my' },
    },
  ],
  [
    'cancel_queued_message reads data.messageId, not payload',
    {
      type: 'data:cancel_queued_message',
      payload: { messageId: 'qy' },
    },
  ],
  ['watcher_get reads payload.id, not data', { type: 'data:watcher_get', id: 'wy' }],
  [
    'watcher_delete_by_thread does not resolve payload.id',
    {
      type: 'data:watcher_delete_by_thread',
      payload: { id: 'wy' },
    },
  ],
  ['job_get with a watcher id resolves nothing', { type: 'data:job_get', payload: { id: 'wy' } }],
  [
    'job_delete_by_thread does not resolve payload.id',
    {
      type: 'data:job_delete_by_thread',
      payload: { id: 'jy' },
    },
  ],
  [
    'resolve_pending reads payload.requestId, not data',
    {
      type: 'data:resolve_pending_permission_request',
      requestId: 'pry',
    },
  ],
  [
    'create_pending does not resolve payload.requestId',
    {
      type: 'data:create_pending_permission_request',
      payload: { requestId: 'pry' },
    },
  ],
  [
    'session id lookup reads data.sessionId, not payload',
    {
      type: 'data:get_thread_by_session_id',
      payload: { sessionId: 'sess-y' },
    },
  ],
  [
    'external id lookup only for its own type',
    {
      type: 'data:get_thread',
      externalRequestId: 'ext-y',
    },
  ],
  ['session id lookup only for its own type', { type: 'data:get_thread', sessionId: 'sess-y' }],
  [
    'unknown external request id',
    {
      type: 'data:get_thread_by_external_request_id',
      externalRequestId: 'nope',
    },
  ],
  [
    'unknown thread id (ownership check handles not-found)',
    {
      type: 'data:get_thread',
      threadId: 'missing',
    },
  ],
  ['non-string thread id', { type: 'data:get_thread', threadId: 123 }],
  ['empty-string thread id', { type: 'data:get_thread', threadId: '' }],
  ['non-string project id', { type: 'data:get_project', projectId: 42 }],
  ['list rule', { type: 'data:list_projects', userId: 'alice' }],
  ['user rule without refs', { type: 'data:get_profile', userId: 'alice' }],
];

describe('assertRunnerDataScope characterization', () => {
  let db: (typeof import('../../db/index.js'))['db'];

  beforeAll(async () => {
    const { initDatabase } = await import('../../db/index.js');
    await initDatabase({ sqlitePath: ':memory:' });
    const { autoMigrate } = await import('../../db/migrate.js');
    await autoMigrate();
    db = (await import('../../db/index.js')).db;
  });

  beforeEach(async () => {
    for (const table of [
      'pending_permission_requests',
      'jobs',
      'watchers',
      'message_queue',
      'tool_calls',
      'project_runner_grants',
      'project_runner_settings',
      'messages',
      'threads',
      'runner_project_assignments',
      'runners',
      'projects',
    ]) {
      (db as any).run(`DELETE FROM ${table}`);
    }
    __resetRunnerScopeCache();
    __resetDataScopeCache();
    const now = new Date().toISOString();
    for (const s of ['x', 'y'] as const) {
      seedProject(db as any, { id: `p${s}`, userId: 'alice', path: `/${s}` });
      seedThread(
        db as any,
        {
          id: `t${s}`,
          projectId: `p${s}`,
          userId: 'alice',
          externalRequestId: `ext-${s}`,
          sessionId: `sess-${s}`,
        } as any,
      );
      seedMessage(db as any, { id: `m${s}`, threadId: `t${s}` });
      seedToolCall(db as any, { id: `tc${s}`, messageId: `m${s}` });
      seedMessageQueue(db as any, { id: `q${s}`, threadId: `t${s}` });
      (db as any)
        .insert(schema.watchers)
        .values({
          id: `w${s}`,
          threadId: `t${s}`,
          userId: 'alice',
          key: 'k',
          label: 'l',
          nextWakeAt: 0,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      (db as any)
        .insert(schema.jobs)
        .values({
          id: `j${s}`,
          threadId: `t${s}`,
          userId: 'alice',
          command: 'true',
          logPath: '/tmp/l',
          exitPath: '/tmp/e',
          startedAt: now,
          updatedAt: now,
        })
        .run();
      (db as any)
        .insert(schema.pendingPermissionRequests)
        .values({
          requestId: `pr${s}`,
          threadId: `t${s}`,
          runId: 'r',
          transport: 't',
          toolCallId: 'tc',
          toolName: 'Bash',
          createdAt: now,
        })
        .run();
    }
    seedThread(
      db as any,
      {
        id: 'ts',
        projectId: null as any,
        userId: 'alice',
        isScratch: 1,
      } as any,
    );
    seedMessage(db as any, { id: 'ms', threadId: 'ts' });
    seedRunner(db as any, { id: 'laptop', userId: 'alice', token: 'tok-l', hostname: 'l' });
    seedRunner(db as any, {
      id: 'rx',
      userId: 'alice',
      token: 'tok-rx',
      hostname: 'rx',
      role: 'dedicated',
    });
    await setProjectDedicatedRunner('px', 'alice', 'rx');
  });

  afterAll(async () => {
    const { closeDatabase } = await import('../../db/index.js');
    await closeDatabase?.();
  });

  describe('every reference shape resolves to the owning project', () => {
    for (const [label, build] of REFERENCE_SHAPES) {
      test(label, async () => {
        expect(await assertRunnerDataScope('rx', build('x'))).toEqual(OK);
        expect(await assertRunnerDataScope('rx', build('y'))).toEqual(OUT_PY);
        expect(await assertRunnerDataScope('laptop', build('y'))).toEqual(OK);
        expect(await assertRunnerDataScope('laptop', build('x'))).toEqual(OUT_PX);
      });
    }
  });

  describe('fields outside their type are not treated as references', () => {
    for (const [label, data] of IGNORED_REFERENCES) {
      test(label, async () => {
        expect(await assertRunnerDataScope('rx', data)).toEqual(OK);
      });
    }
  });

  test('unknown or missing types fail closed', async () => {
    expect(await assertRunnerDataScope('laptop', { type: 'data:nope' })).toEqual({
      ok: false,
      reason: 'no scope rule for data:nope',
    });
    expect(await assertRunnerDataScope('laptop', {})).toEqual({
      ok: false,
      reason: 'no scope rule for undefined',
    });
    expect(await assertRunnerDataScope('laptop', null)).toEqual({
      ok: false,
      reason: 'no scope rule for undefined',
    });
    expect(await assertRunnerDataScope('laptop', undefined)).toEqual({
      ok: false,
      reason: 'no scope rule for undefined',
    });
  });

  test('projectless rule: general runners only', async () => {
    const data = { type: 'data:create_project', projectId: 'px', payload: { threadId: 'tx' } };
    expect(await assertRunnerDataScope('rx', data)).toEqual({
      ok: false,
      reason: 'data:create_project is projectless work (general runners only)',
    });
    expect(await assertRunnerDataScope('laptop', data)).toEqual(OK);
  });

  test('create_thread without a project is scratch creation', async () => {
    const reason = 'data:create_thread is projectless work (general runners only)';
    for (const data of [
      { type: 'data:create_thread' },
      { type: 'data:create_thread', payload: {} },
      { type: 'data:create_thread', payload: { projectId: '' }, projectId: '' },
      { type: 'data:create_thread', payload: { projectId: 7 } },
    ]) {
      expect(await assertRunnerDataScope('rx', data)).toEqual({ ok: false, reason });
      expect(await assertRunnerDataScope('laptop', data)).toEqual(OK);
    }
    // Scratch create short-circuits before thread refs are inspected.
    expect(
      await assertRunnerDataScope('laptop', { type: 'data:create_thread', threadId: 'tx' }),
    ).toEqual(OK);
  });

  test('create_thread with a project is checked against that project', async () => {
    const viaPayload = { type: 'data:create_thread', payload: { projectId: 'px' } };
    const viaData = { type: 'data:create_thread', projectId: 'px' };
    expect(await assertRunnerDataScope('rx', viaPayload)).toEqual(OK);
    expect(await assertRunnerDataScope('rx', viaData)).toEqual(OK);
    expect(await assertRunnerDataScope('laptop', viaPayload)).toEqual(OUT_PX);
    expect(await assertRunnerDataScope('laptop', viaData)).toEqual(OUT_PX);
  });

  test('scratch thread references need a general runner', async () => {
    for (const data of [
      { type: 'data:get_thread', threadId: 'ts' },
      { type: 'data:update_message', payload: { messageId: 'ms' } },
    ]) {
      expect(await assertRunnerDataScope('rx', data)).toEqual(OUT_SCRATCH);
      expect(await assertRunnerDataScope('laptop', data)).toEqual(OK);
    }
  });

  test('multiple references: every one must pass; project reasons come first', async () => {
    // own project + scratch → scratch refusal
    expect(
      await assertRunnerDataScope('rx', {
        type: 'data:insert_message',
        threadId: 'tx',
        payload: { threadId: 'ts' },
      }),
    ).toEqual(OUT_SCRATCH);
    // other project + scratch → project refusal reported first
    expect(
      await assertRunnerDataScope('rx', {
        type: 'data:insert_message',
        threadId: 'ty',
        payload: { threadId: 'ts' },
      }),
    ).toEqual(OUT_PY);
    // explicit projectId disagrees with the thread's project
    expect(
      await assertRunnerDataScope('rx', {
        type: 'data:get_thread',
        threadId: 'tx',
        projectId: 'py',
      }),
    ).toEqual(OUT_PY);
    // indirect ref disagrees with a direct one
    expect(
      await assertRunnerDataScope('rx', {
        type: 'data:update_message',
        threadId: 'tx',
        payload: { messageId: 'my' },
      }),
    ).toEqual(OUT_PY);
    // direct project refs are checked in insertion order (data before payload)
    expect(
      await assertRunnerDataScope('laptop', {
        type: 'data:get_project',
        projectId: 'px',
        payload: { projectId: 'py' },
      }),
    ).toEqual(OUT_PX);
    expect(
      await assertRunnerDataScope('rx', {
        type: 'data:get_project',
        projectId: 'py',
        payload: { projectId: 'px', threadId: 'ty' },
      }),
    ).toEqual(OUT_PY);
  });

  test('Object.prototype keys as type resolve no indirect references', async () => {
    // Current behavior: DATA_SCOPE_RULES is a plain object, so a prototype key
    // yields a truthy "rule" and only direct refs are checked. data-handler's
    // switch refuses such types anyway; this pins that no lookup crashes.
    const data = { type: 'toString', payload: { messageId: 'my', id: 'wy' } };
    expect(await assertRunnerDataScope('rx', data)).toEqual(OK);
    expect(await assertRunnerDataScope('rx', { type: 'toString', threadId: 'ty' })).toEqual(OUT_PY);
  });

  test('payload fallback when payload is null', async () => {
    expect(
      await assertRunnerDataScope('rx', { type: 'data:get_thread', threadId: 'ty', payload: null }),
    ).toEqual(OUT_PY);
    expect(
      await assertRunnerDataScope('rx', { type: 'data:update_message', payload: null }),
    ).toEqual(OK);
  });
});
