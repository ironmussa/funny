import { describe, test, expect, vi, beforeEach } from 'vitest';

// ── Mocks ────────────────────────────────────────────────────────

const mockGetThread = vi.fn(() => undefined as any);
const mockGetThreadWithMessages = vi.fn(() => undefined as any);
const mockGetProject = vi.fn(() => undefined as any);
const mockIsProjectInOrg = vi.fn(() => false);

vi.mock('../../services/thread-manager.js', () => ({
  getThread: mockGetThread,
  getThreadWithMessages: mockGetThreadWithMessages,
}));

vi.mock('../../services/project-manager.js', () => ({
  getProject: mockGetProject,
}));

vi.mock('../../services/service-registry.js', () => ({
  getServices: () => ({
    projects: {
      getProject: mockGetProject,
      isProjectInOrg: mockIsProjectInOrg,
    },
  }),
}));

// Import under test AFTER mocks are registered
const { requireThread, requireThreadWithMessages, requireProject, requireThreadCwd } =
  await import('../../utils/route-helpers.js');

// ── Test data ────────────────────────────────────────────────────

const fakeThread = {
  id: 't1',
  projectId: 'p1',
  title: 'Test thread',
  worktreePath: null as string | null,
  status: 'idle',
  createdAt: '2026-01-01T00:00:00.000Z',
};

const fakeThreadWithMessages = {
  ...fakeThread,
  messages: [{ id: 'm1', threadId: 't1', role: 'user', text: 'hello' }],
  hasMore: false,
};

const fakeProject = {
  id: 'p1',
  name: 'My Project',
  path: '/home/user/my-project',
  createdAt: '2026-01-01T00:00:00.000Z',
};

// ── Helpers ──────────────────────────────────────────────────────

beforeEach(() => {
  mockGetThread.mockReset();
  mockGetThreadWithMessages.mockReset();
  mockGetProject.mockReset();
  mockIsProjectInOrg.mockReset();
});

// ── requireThread ────────────────────────────────────────────────

describe('requireThread', () => {
  test('returns Ok with the thread when found', async () => {
    mockGetThread.mockReturnValue(fakeThread);

    const result = await requireThread('t1');

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual(fakeThread);
    expect(mockGetThread).toHaveBeenCalledWith('t1');
  });

  test('returns Err(NOT_FOUND) when thread does not exist', async () => {
    mockGetThread.mockReturnValue(undefined);

    const result = await requireThread('nonexistent');

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe('NOT_FOUND');
    expect(error.message).toBe('Thread not found');
  });
});

// ── requireThreadWithMessages ────────────────────────────────────

describe('requireThreadWithMessages', () => {
  test('returns Ok with thread and messages when found', async () => {
    mockGetThreadWithMessages.mockReturnValue(fakeThreadWithMessages);

    const result = await requireThreadWithMessages('t1');

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual(fakeThreadWithMessages);
    expect(mockGetThreadWithMessages).toHaveBeenCalledWith('t1');
  });

  test('returns Err(NOT_FOUND) when thread does not exist', async () => {
    mockGetThreadWithMessages.mockReturnValue(null);

    const result = await requireThreadWithMessages('nonexistent');

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe('NOT_FOUND');
    expect(error.message).toBe('Thread not found');
  });
});

// ── requireProject ───────────────────────────────────────────────

describe('requireProject', () => {
  test('returns Ok with the project when found', async () => {
    mockGetProject.mockReturnValue(fakeProject);

    const result = await requireProject('p1');

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.id).toBe('p1');
    }
  });

  test('returns Err(NOT_FOUND) when project does not exist', async () => {
    mockGetProject.mockReturnValue(null);

    const result = await requireProject('nonexistent');

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe('NOT_FOUND');
      expect(result.error.message).toBe('Project not found');
    }
  });
});

// ── requireThreadCwd ─────────────────────────────────────────────

describe('requireThreadCwd', () => {
  test('returns worktreePath when thread has one', async () => {
    const threadWithWorktree = { ...fakeThread, worktreePath: '/tmp/worktrees/t1' };
    mockGetThread.mockReturnValue(threadWithWorktree);

    const result = await requireThreadCwd('t1');

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toBe('/tmp/worktrees/t1');
  });

  test('returns project path when thread has no worktreePath', async () => {
    const threadNoWorktree = { ...fakeThread, worktreePath: null };
    mockGetThread.mockReturnValue(threadNoWorktree);
    mockGetProject.mockReturnValue(fakeProject);

    const result = await requireThreadCwd('t1');

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toBe('/home/user/my-project');
    expect(mockGetProject).toHaveBeenCalledWith('p1');
  });

  test('returns Err(NOT_FOUND) when thread does not exist', async () => {
    mockGetThread.mockReturnValue(undefined);

    const result = await requireThreadCwd('nonexistent');

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe('NOT_FOUND');
    expect(error.message).toBe('Thread not found');
  });

  test('returns Err(NOT_FOUND) when project does not exist', async () => {
    const threadNoWorktree = { ...fakeThread, worktreePath: null };
    mockGetThread.mockReturnValue(threadNoWorktree);
    mockGetProject.mockReturnValue(undefined);

    const result = await requireThreadCwd('t1');

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe('NOT_FOUND');
    expect(error.message).toBe('Project not found');
  });
});
