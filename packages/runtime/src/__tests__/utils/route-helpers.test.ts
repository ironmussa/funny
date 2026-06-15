import { ok, err } from 'neverthrow';
import { describe, test, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  getThread: vi.fn(),
  getThreadWithMessages: vi.fn(),
  getProject: vi.fn(),
  isProjectInOrg: vi.fn(),
  resolveProjectPath: vi.fn(),
}));

vi.mock('../../services/thread-manager.js', () => ({
  getThread: mocks.getThread,
  getThreadWithMessages: mocks.getThreadWithMessages,
}));

vi.mock('../../services/service-registry.js', () => ({
  getServices: () => ({
    projects: {
      getProject: mocks.getProject,
      isProjectInOrg: mocks.isProjectInOrg,
      resolveProjectPath: mocks.resolveProjectPath,
    },
  }),
}));

import {
  requireThread,
  requireThreadWithMessages,
  requireProject,
  requireThreadCwd,
  isSteerGrantFor,
} from '../../utils/route-helpers.js';

describe('route-helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: caller is not a collaborator (no member local path). Tests that
    // exercise the collaborator path override this.
    mocks.resolveProjectPath.mockResolvedValue(err({ type: 'BAD_REQUEST', message: 'no path' }));
  });

  test('requireThread returns not found when thread is missing', async () => {
    mocks.getThread.mockResolvedValue(undefined);

    const result = await requireThread('missing', 'u-1');

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe('NOT_FOUND');
    }
  });

  test('requireThread rejects access from another user', async () => {
    mocks.getThread.mockResolvedValue({ id: 't-1', userId: 'owner', projectId: 'p-1' });
    mocks.isProjectInOrg.mockResolvedValue(false);

    const result = await requireThread('t-1', 'other-user', 'org-1');

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe('FORBIDDEN');
    }
  });

  test('requireThread allows team org access to shared project threads', async () => {
    const thread = { id: 't-1', userId: 'owner', projectId: 'p-1' };
    mocks.getThread.mockResolvedValue(thread);
    mocks.isProjectInOrg.mockResolvedValue(true);

    const result = await requireThread('t-1', 'teammate', 'org-1');

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toEqual(thread);
    }
  });

  test('requireThreadWithMessages returns thread detail for owner', async () => {
    const detail = { id: 't-1', userId: 'u-1', projectId: 'p-1', messages: [] };
    mocks.getThreadWithMessages.mockResolvedValue(detail);

    const result = await requireThreadWithMessages('t-1', 'u-1');

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.messages).toEqual([]);
    }
  });

  test('requireProject returns project for owner', async () => {
    mocks.getProject.mockResolvedValue({ id: 'p-1', userId: 'u-1', path: '/repo' });

    const result = await requireProject('p-1', 'u-1');

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.path).toBe('/repo');
    }
  });

  test('requireThreadCwd prefers worktreePath over project path', async () => {
    mocks.getThread.mockResolvedValue({
      id: 't-1',
      userId: 'u-1',
      projectId: 'p-1',
      worktreePath: '/wt/feature',
    });

    const result = await requireThreadCwd('t-1', 'u-1');

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toBe('/wt/feature');
    }
    expect(mocks.getProject).not.toHaveBeenCalled();
  });

  test('requireThreadCwd falls back to project path', async () => {
    mocks.getThread.mockResolvedValue({
      id: 't-1',
      userId: 'u-1',
      projectId: 'p-1',
      worktreePath: null,
    });
    mocks.getProject.mockResolvedValue({ id: 'p-1', path: '/repo/main' });

    const result = await requireThreadCwd('t-1', 'u-1');

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toBe('/repo/main');
    }
  });

  test('requireThreadWithMessages allows org teammate access', async () => {
    const detail = { id: 't-1', userId: 'owner', projectId: 'p-1', messages: [] };
    mocks.getThreadWithMessages.mockResolvedValue(detail);
    mocks.isProjectInOrg.mockResolvedValue(true);

    const result = await requireThreadWithMessages('t-1', 'teammate', 'org-1');

    expect(result.isOk()).toBe(true);
    expect(mocks.isProjectInOrg).toHaveBeenCalledWith('p-1', 'org-1');
  });

  test('requireProject rejects non-owner without org access', async () => {
    mocks.getProject.mockResolvedValue({ id: 'p-1', userId: 'owner', path: '/repo' });
    mocks.isProjectInOrg.mockResolvedValue(false);

    const result = await requireProject('p-1', 'other-user', 'org-1');

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe('FORBIDDEN');
    }
  });

  test('requireProject allows org teammate access', async () => {
    const project = { id: 'p-1', userId: 'owner', path: '/repo' };
    mocks.getProject.mockResolvedValue(project);
    mocks.isProjectInOrg.mockResolvedValue(true);

    const result = await requireProject('p-1', 'teammate', 'org-1');

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toEqual(project);
    }
  });

  test('requireProject authorizes a collaborator and overrides path with their own', async () => {
    // Project owned by someone else, not shared via org — but the caller is a
    // collaborator (project_members), so resolveProjectPath returns THEIR path.
    mocks.getProject.mockResolvedValue({ id: 'p-1', userId: 'owner', path: '/owner/repo' });
    mocks.isProjectInOrg.mockResolvedValue(false);
    mocks.resolveProjectPath.mockResolvedValue(ok('/home/collab/repo'));

    const result = await requireProject('p-1', 'collab-user');

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      // Authorized AND the path is the collaborator's, not the owner's.
      expect(result.value.path).toBe('/home/collab/repo');
    }
    expect(mocks.resolveProjectPath).toHaveBeenCalledWith('p-1', 'collab-user');
  });

  test('requireThreadCwd uses the collaborator resolved path for local-mode threads', async () => {
    mocks.getThread.mockResolvedValue({
      id: 't-1',
      userId: 'collab-user',
      projectId: 'p-1',
      worktreePath: null,
    });
    mocks.resolveProjectPath.mockResolvedValue(ok('/home/collab/repo'));

    const result = await requireThreadCwd('t-1', 'collab-user');

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toBe('/home/collab/repo');
    }
    // Per-user resolution wins — we never fall back to the owner project path.
    expect(mocks.getProject).not.toHaveBeenCalled();
  });

  // ── Steer-share delegation (thread-sharing-steer) ──────────────────────

  test('isSteerGrantFor matches only a steer grant for the same thread', () => {
    expect(isSteerGrantFor('t-1', { shareLevel: 'steer', onBehalfOfThread: 't-1' })).toBe(true);
    expect(isSteerGrantFor('t-1', { shareLevel: 'steer', onBehalfOfThread: 't-2' })).toBe(false);
    expect(isSteerGrantFor('t-1', { shareLevel: 'view', onBehalfOfThread: 't-1' })).toBe(false);
    expect(isSteerGrantFor('t-1', undefined)).toBe(false);
  });

  test('requireThread authorizes a steer sharee for the matching thread', async () => {
    const thread = { id: 't-1', userId: 'owner', projectId: 'p-1' };
    mocks.getThread.mockResolvedValue(thread);
    mocks.isProjectInOrg.mockResolvedValue(false);

    const result = await requireThread('t-1', 'sharee', null, {
      shareLevel: 'steer',
      onBehalfOfThread: 't-1',
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) expect(result.value).toEqual(thread);
    // Authorized off the signed claim — no org lookup needed.
    expect(mocks.isProjectInOrg).not.toHaveBeenCalled();
  });

  test('requireThread rejects a steer claim pointed at a DIFFERENT thread', async () => {
    mocks.getThread.mockResolvedValue({ id: 't-1', userId: 'owner', projectId: 'p-1' });
    mocks.isProjectInOrg.mockResolvedValue(false);

    const result = await requireThread('t-1', 'sharee', null, {
      shareLevel: 'steer',
      onBehalfOfThread: 't-2',
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.type).toBe('FORBIDDEN');
  });

  test('requireThread rejects a view-level claim (only steer delegates)', async () => {
    mocks.getThread.mockResolvedValue({ id: 't-1', userId: 'owner', projectId: 'p-1' });
    mocks.isProjectInOrg.mockResolvedValue(false);

    const result = await requireThread('t-1', 'sharee', null, {
      shareLevel: 'view',
      onBehalfOfThread: 't-1',
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.type).toBe('FORBIDDEN');
  });

  test('requireThreadCwd resolves a steer sharee to the OWNER path, not the sharee', async () => {
    mocks.getThread.mockResolvedValue({
      id: 't-1',
      userId: 'owner',
      projectId: 'p-1',
      worktreePath: null,
    });
    // Path resolution must be attempted with the OWNER id, returning the owner's
    // checkout — the sharee has no path on this runner.
    mocks.resolveProjectPath.mockImplementation(async (_pid: string, uid: string) =>
      uid === 'owner' ? ok('/home/owner/repo') : err({ type: 'BAD_REQUEST', message: 'no path' }),
    );

    const result = await requireThreadCwd('t-1', 'sharee', null, {
      shareLevel: 'steer',
      onBehalfOfThread: 't-1',
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) expect(result.value).toBe('/home/owner/repo');
    expect(mocks.resolveProjectPath).toHaveBeenCalledWith('p-1', 'owner');
  });

  test('requireThreadCwd prefers the owner worktreePath for a steer sharee', async () => {
    mocks.getThread.mockResolvedValue({
      id: 't-1',
      userId: 'owner',
      projectId: 'p-1',
      worktreePath: '/wt/owner-feature',
    });

    const result = await requireThreadCwd('t-1', 'sharee', null, {
      shareLevel: 'steer',
      onBehalfOfThread: 't-1',
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) expect(result.value).toBe('/wt/owner-feature');
  });

  test('requireThreadCwd returns not found when project is missing', async () => {
    mocks.getThread.mockResolvedValue({
      id: 't-1',
      userId: 'u-1',
      projectId: 'p-missing',
      worktreePath: null,
    });
    mocks.getProject.mockResolvedValue(undefined);

    const result = await requireThreadCwd('t-1', 'u-1');

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe('NOT_FOUND');
    }
  });
});
