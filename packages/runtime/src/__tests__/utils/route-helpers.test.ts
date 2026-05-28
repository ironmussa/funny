import { describe, test, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  getThread: vi.fn(),
  getThreadWithMessages: vi.fn(),
  getProject: vi.fn(),
  isProjectInOrg: vi.fn(),
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
    },
  }),
}));

import {
  requireThread,
  requireThreadWithMessages,
  requireProject,
  requireThreadCwd,
} from '../../utils/route-helpers.js';

describe('route-helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
