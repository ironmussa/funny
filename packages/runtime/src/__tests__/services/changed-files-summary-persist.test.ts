import { ok } from 'neverthrow';
import { describe, test, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  getDiffSummary: vi.fn(),
  getIgnoredFileStats: vi.fn(),
  saveThreadEvent: vi.fn(async () => undefined),
}));

vi.mock('@funny/core/git', () => ({
  getDiffSummary: mocks.getDiffSummary,
  getIgnoredFileStats: mocks.getIgnoredFileStats,
  getStatusSummary: vi.fn(),
  deriveGitSyncState: vi.fn(),
}));

vi.mock('../../lib/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../services/service-registry.js', () => ({
  getServices: () => ({ threadEvents: { saveThreadEvent: mocks.saveThreadEvent } }),
}));

vi.mock('../../services/team-client.js', () => ({
  flushPendingMessageUpdates: vi.fn(),
}));

import { AgentMessageHandler } from '../../services/agent-message-handler.js';
import { AgentStateTracker } from '../../services/agent-state.js';

function makeHandler(threadWithMessages: any) {
  const wsEvents: any[] = [];
  const threadManager: any = {
    getThreadWithMessages: vi.fn(async () => threadWithMessages),
    getThread: vi.fn(async () => ({ userId: 'user-1' })),
  };
  const wsBroker: any = {
    emit: (e: any) => wsEvents.push(e),
    emitToUser: (_uid: string, e: any) => wsEvents.push(e),
  };
  const getProject = vi.fn(async () => ({ id: 'p1', path: '/repo' }));
  const handler = new AgentMessageHandler(
    new AgentStateTracker(),
    threadManager,
    wsBroker,
    getProject as any,
  );
  return { handler, wsEvents };
}

const session = (userId: string, ...absPaths: string[]) => [
  { id: userId, role: 'user', content: 'go', toolCalls: [] },
  {
    id: `a-${userId}`,
    role: 'assistant',
    content: '',
    toolCalls: absPaths.map((p, i) => ({
      id: `${userId}-tc${i}`,
      name: 'Edit',
      input: { file_path: p },
    })),
  },
];

describe('AgentMessageHandler.persistChangedFilesSummary', () => {
  beforeEach(() => {
    mocks.getDiffSummary.mockReset();
    mocks.getIgnoredFileStats.mockReset();
    mocks.getIgnoredFileStats.mockReturnValue(ok(new Map()));
    mocks.saveThreadEvent.mockReset();
    mocks.saveThreadEvent.mockResolvedValue(undefined);
  });

  test('persists a frozen summary keyed by the latest session, with diff stats', async () => {
    mocks.getDiffSummary.mockReturnValue(
      ok({
        files: [
          { path: 'src/a.ts', status: 'modified', staged: false, additions: 22, deletions: 6 },
        ],
        total: 1,
      }),
    );
    const { handler, wsEvents } = makeHandler({
      projectId: 'p1',
      worktreePath: null,
      isScratch: false,
      messages: session('u1', '/repo/src/a.ts'),
    });

    await (handler as any).persistChangedFilesSummary('t1');

    expect(mocks.saveThreadEvent).toHaveBeenCalledTimes(1);
    const [threadId, type, data]: any = mocks.saveThreadEvent.mock.calls[0] as any;
    expect(type).toBe('changed_files_summary');
    expect(threadId).toBe('t1');
    expect(data.userMessageId).toBe('u1');
    expect(data.files[0]).toMatchObject({ path: 'src/a.ts', additions: 22, deletions: 6 });

    // Broadcasts a thread:event so the live client shows it at session end.
    const ev = wsEvents.find((e) => e.type === 'thread:event');
    expect(ev).toBeTruthy();
    expect(ev.data.event.type).toBe('changed_files_summary');
  });

  test('backfills +/- for gitignored files absent from the working-tree diff', async () => {
    // openspec/ is gitignored, so getDiffSummary never reports it → stat-less row.
    mocks.getDiffSummary.mockReturnValue(ok({ files: [], total: 0 }));
    mocks.getIgnoredFileStats.mockReturnValue(
      ok(new Map([['openspec/changes/x/tasks.md', { additions: 12, deletions: 0 }]])),
    );
    const { handler } = makeHandler({
      projectId: 'p1',
      worktreePath: null,
      isScratch: false,
      messages: session('u1', '/repo/openspec/changes/x/tasks.md'),
    });

    await (handler as any).persistChangedFilesSummary('t1');

    // The ignored subset is the only stat-less path we ask about.
    expect(mocks.getIgnoredFileStats).toHaveBeenCalledWith('/repo', [
      'openspec/changes/x/tasks.md',
    ]);
    const [, , data]: any = mocks.saveThreadEvent.mock.calls[0] as any;
    expect(data.files[0]).toMatchObject({
      path: 'openspec/changes/x/tasks.md',
      additions: 12,
      deletions: 0,
    });
  });

  test('skips scratch threads (no repo)', async () => {
    mocks.getDiffSummary.mockReturnValue(ok({ files: [], total: 0 }));
    const { handler } = makeHandler({
      projectId: '',
      worktreePath: null,
      isScratch: true,
      messages: session('u1', '/repo/src/a.ts'),
    });

    await (handler as any).persistChangedFilesSummary('t1');

    expect(mocks.getDiffSummary).not.toHaveBeenCalled();
    expect(mocks.saveThreadEvent).not.toHaveBeenCalled();
  });

  test('persists nothing when the latest session touched no files', async () => {
    mocks.getDiffSummary.mockReturnValue(ok({ files: [], total: 0 }));
    const { handler } = makeHandler({
      projectId: 'p1',
      worktreePath: null,
      isScratch: false,
      messages: [{ id: 'u1', role: 'user', content: 'hi', toolCalls: [] }],
    });

    await (handler as any).persistChangedFilesSummary('t1');

    expect(mocks.saveThreadEvent).not.toHaveBeenCalled();
  });
});
