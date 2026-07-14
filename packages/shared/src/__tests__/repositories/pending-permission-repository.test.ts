import { describe, expect, test, beforeEach } from 'bun:test';

import { createPendingPermissionRepository } from '../../repositories/pending-permission-repository.js';
import { createTestDb, seedProject, seedThread } from '../helpers/test-db.js';

let deps: ReturnType<typeof createTestDb>;
let repo: ReturnType<typeof createPendingPermissionRepository>;

const request = (overrides: Partial<Parameters<typeof repo.create>[0]> = {}) => ({
  requestId: 'permission-1',
  threadId: 't1',
  runId: 'run-1',
  transport: 'codex-acp' as const,
  toolCallId: 'tool-1',
  toolName: 'Bash',
  toolInput: '{"command":"git status"}',
  canAlwaysAllow: true,
  canDeny: true,
  requestedAt: '2026-07-13T00:00:00.000Z',
  ...overrides,
});

beforeEach(() => {
  deps = createTestDb();
  repo = createPendingPermissionRepository(deps);
  seedProject(deps.db);
  seedThread(deps.db);
});

describe('pending permission repository', () => {
  test('returns the active, sanitized request for a thread', async () => {
    await repo.create(request());

    expect(await repo.getActive('t1')).toEqual({
      requestId: 'permission-1',
      threadId: 't1',
      runId: 'run-1',
      transport: 'codex-acp',
      toolCallId: 'tool-1',
      toolName: 'Bash',
      toolInput: '{"command":"git status"}',
      canAlwaysAllow: true,
      canDeny: true,
      requestedAt: '2026-07-13T00:00:00.000Z',
    });
  });

  test('expires an older active request for the same thread and run', async () => {
    await repo.create(request());
    await repo.create(request({ requestId: 'permission-2', toolCallId: 'tool-2' }));

    expect(await repo.getActiveById('permission-1')).toBeNull();
    expect((await repo.getById('permission-1'))?.status).toBe('expired');
    expect((await repo.getActive('t1'))?.requestId).toBe('permission-2');
  });

  test('keeps resolved records for stale-request checks', async () => {
    await repo.create(request());

    expect(await repo.resolve('permission-1', 'allow_once')).toBe(true);
    expect(await repo.resolve('permission-1', 'allow_once')).toBe(false);
    expect(await repo.getActive('t1')).toBeNull();
    expect(await repo.getById('permission-1')).toMatchObject({
      status: 'resolved',
      resolvedDecision: 'allow_once',
    });
  });

  test('expires active records and leaves threads with no historical request empty', async () => {
    expect(await repo.getActive('t1')).toBeNull();
    await repo.create(request());

    expect(await repo.expire('permission-1')).toBe(true);
    expect(await repo.expire('permission-1')).toBe(false);
    expect(await repo.getById('permission-1')).toMatchObject({ status: 'expired' });
  });
});
