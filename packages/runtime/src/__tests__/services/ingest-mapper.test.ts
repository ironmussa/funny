import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  tm: {
    createThread: vi.fn(async () => undefined),
    getThread: vi.fn(async () => null),
    getThreadByExternalRequestId: vi.fn(async () => undefined),
    updateThread: vi.fn(async () => undefined),
    updateMessage: vi.fn(async () => undefined),
    insertMessage: vi.fn(async () => 'msg-1'),
    insertToolCall: vi.fn(async () => 'tc-1'),
    updateToolCallOutput: vi.fn(async () => undefined),
    findToolCall: vi.fn(async () => undefined),
  },
  projects: {
    listProjects: vi.fn(async () => []),
    getProject: vi.fn(async () => ({ id: 'p-1', path: '/projects/app' })),
  },
  wsBroker: {
    emitToUser: vi.fn(),
    emit: vi.fn(),
  },
  getCurrentBranch: vi.fn(async () => ({ isOk: () => true, isErr: () => false, value: 'main' })),
  getRemoteUrl: vi.fn(),
}));

vi.mock('nanoid', () => ({ nanoid: () => 'ingest-thread-id' }));

vi.mock('../../lib/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../services/thread-manager.js', () => mocks.tm);

vi.mock('../../services/service-registry.js', () => ({
  getServices: () => ({ projects: mocks.projects }),
}));

vi.mock('../../services/ws-broker.js', () => ({
  wsBroker: mocks.wsBroker,
}));

vi.mock('../../services/shutdown-manager.js', () => ({
  shutdownManager: { register: vi.fn() },
  ShutdownPhase: { SERVICES: 'services' },
}));

vi.mock('@funny/core/git', () => ({
  getCurrentBranch: mocks.getCurrentBranch,
  getRemoteUrl: mocks.getRemoteUrl,
}));

import { ok } from 'neverthrow';

import {
  cleanupExternalThread,
  handleIngestEvent,
  startExternalThreadSweep,
  sweepStaleExternalThreads,
  type IngestEvent,
} from '../../services/ingest-mapper.js';
import { shutdownManager } from '../../services/shutdown-manager.js';

function baseEvent(overrides: Partial<IngestEvent> = {}): IngestEvent {
  return {
    event_type: 'session.accepted',
    request_id: 'req-123',
    timestamp: new Date().toISOString(),
    data: {},
    ...overrides,
  };
}

describe('handleIngestEvent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrentBranch.mockResolvedValue(ok('main'));
    mocks.tm.getThreadByExternalRequestId.mockResolvedValue(undefined);
  });

  test('ignores silent pipeline lifecycle events', async () => {
    const result = await handleIngestEvent(
      baseEvent({
        event_type: 'pipeline.started',
        request_id: 'req-silent',
      }),
    );

    expect(result).toEqual({});
    expect(mocks.tm.createThread).not.toHaveBeenCalled();
    expect(mocks.tm.insertMessage).not.toHaveBeenCalled();
  });

  test('creates an external thread on accepted with explicit projectId', async () => {
    const result = await handleIngestEvent(
      baseEvent({
        metadata: { projectId: 'p-1', userId: 'u-1' },
        data: { title: 'Review PR', prompt: 'Please review' },
      }),
    );

    expect(result.threadId).toBe('ingest-thread-id');
    expect(mocks.tm.createThread).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'ingest-thread-id',
        projectId: 'p-1',
        userId: 'u-1',
        provider: 'external',
        title: 'Review PR',
      }),
    );
    expect(mocks.tm.insertMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: 'ingest-thread-id',
        role: 'user',
        content: 'Please review',
      }),
    );
    expect(mocks.wsBroker.emitToUser).toHaveBeenCalled();
  });

  test('links accepted event to an existing UI thread via thread_id', async () => {
    mocks.tm.getThread.mockResolvedValue({
      id: 't-existing',
      projectId: 'p-1',
      userId: 'u-1',
    });

    const result = await handleIngestEvent(
      baseEvent({
        thread_id: 't-existing',
        data: { prompt: 'Continue externally' },
      }),
    );

    expect(result.threadId).toBe('t-existing');
    expect(mocks.tm.createThread).not.toHaveBeenCalled();
    expect(mocks.tm.updateThread).toHaveBeenCalledWith('t-existing', { provider: 'external' });
    expect(mocks.tm.insertMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: 't-existing',
        content: 'Continue externally',
      }),
    );
  });

  test('persists unknown events as system messages when thread state exists', async () => {
    mocks.tm.getThread.mockResolvedValue({
      id: 't-existing',
      projectId: 'p-1',
      userId: 'u-1',
    });

    await handleIngestEvent(
      baseEvent({
        event_type: 'vendor.custom_event',
        thread_id: 't-existing',
        request_id: 'req-custom',
        data: { message: 'Something happened' },
      }),
    );

    expect(mocks.tm.insertMessage).toHaveBeenCalledWith({
      threadId: 't-existing',
      role: 'system',
      content: '[vendor.custom_event] Something happened',
    });
    expect(mocks.wsBroker.emitToUser).toHaveBeenCalledWith(
      'u-1',
      expect.objectContaining({
        type: 'agent:message',
        threadId: 't-existing',
      }),
    );
  });
});

describe('cleanupExternalThread', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrentBranch.mockResolvedValue(ok('main'));
    mocks.tm.getThreadByExternalRequestId.mockResolvedValue(undefined);
  });

  test('updates DB even when no in-memory ingest state exists', async () => {
    await cleanupExternalThread('t-orphan');

    expect(mocks.tm.updateThread).toHaveBeenCalledWith(
      't-orphan',
      expect.objectContaining({ status: 'stopped' }),
    );
  });

  test('cleans in-memory state and emits stopped status after accepted flow', async () => {
    await handleIngestEvent(
      baseEvent({
        request_id: 'req-cleanup',
        metadata: { projectId: 'p-1', userId: 'u-1' },
      }),
    );

    mocks.tm.updateThread.mockClear();
    mocks.wsBroker.emitToUser.mockClear();

    await cleanupExternalThread('ingest-thread-id');

    expect(mocks.tm.updateThread).toHaveBeenCalledWith(
      'ingest-thread-id',
      expect.objectContaining({ status: 'stopped' }),
    );
    expect(mocks.wsBroker.emitToUser).toHaveBeenCalledWith(
      'u-1',
      expect.objectContaining({
        type: 'agent:status',
        data: { status: 'stopped' },
      }),
    );
  });
});

describe('handleIngestEvent lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrentBranch.mockResolvedValue(ok('main'));
  });

  async function seedExternalThread(requestId = 'req-life') {
    await handleIngestEvent(
      baseEvent({
        request_id: requestId,
        metadata: { projectId: 'p-1', userId: 'u-1' },
      }),
    );
    mocks.tm.updateThread.mockClear();
    mocks.wsBroker.emitToUser.mockClear();
    mocks.tm.insertMessage.mockClear();
    return requestId;
  }

  test('marks thread running on started event', async () => {
    const requestId = await seedExternalThread('req-started');

    await handleIngestEvent(
      baseEvent({
        event_type: 'session.started',
        request_id: requestId,
      }),
    );

    expect(mocks.tm.updateThread).toHaveBeenCalledWith(
      'ingest-thread-id',
      expect.objectContaining({ status: 'running' }),
    );
  });

  test('finalizes completed external thread with review stage', async () => {
    const requestId = await seedExternalThread('req-done');

    await handleIngestEvent(
      baseEvent({
        event_type: 'session.completed',
        request_id: requestId,
        data: { cost_usd: 0.42, result: 'All good' },
      }),
    );

    expect(mocks.tm.updateThread).toHaveBeenCalledWith(
      'ingest-thread-id',
      expect.objectContaining({
        status: 'completed',
        stage: 'review',
        cost: 0.42,
      }),
    );
    expect(mocks.wsBroker.emitToUser).toHaveBeenCalledWith(
      'u-1',
      expect.objectContaining({
        type: 'agent:result',
        data: expect.objectContaining({ status: 'completed', result: 'All good' }),
      }),
    );
  });

  test('finalizes failed external thread with error message', async () => {
    const requestId = await seedExternalThread('req-fail');

    await handleIngestEvent(
      baseEvent({
        event_type: 'session.failed',
        request_id: requestId,
        data: { error: 'boom', cost_usd: 0.01 },
      }),
    );

    expect(mocks.tm.insertMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        role: 'assistant',
        content: 'Error: boom',
      }),
    );
    expect(mocks.tm.updateThread).toHaveBeenCalledWith(
      'ingest-thread-id',
      expect.objectContaining({ status: 'failed', cost: 0.01 }),
    );
  });

  test('marks thread stopped on stopped event', async () => {
    const requestId = await seedExternalThread('req-stop');

    await handleIngestEvent(
      baseEvent({
        event_type: 'session.stopped',
        request_id: requestId,
      }),
    );

    expect(mocks.tm.updateThread).toHaveBeenCalledWith(
      'ingest-thread-id',
      expect.objectContaining({ status: 'stopped' }),
    );
    expect(mocks.wsBroker.emitToUser).toHaveBeenCalledWith(
      'u-1',
      expect.objectContaining({
        type: 'agent:status',
        data: { status: 'stopped' },
      }),
    );
  });
});

describe('handleIngestEvent — CLI messages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrentBranch.mockResolvedValue(ok('main'));
  });

  async function seedExternalThread(requestId = 'req-cli') {
    await handleIngestEvent(
      baseEvent({
        request_id: requestId,
        metadata: { projectId: 'p-1', userId: 'u-1' },
      }),
    );
    mocks.tm.updateThread.mockClear();
    mocks.wsBroker.emitToUser.mockClear();
    mocks.tm.insertMessage.mockClear();
    mocks.tm.insertToolCall.mockClear();
    return requestId;
  }

  test('handles CLI system init with session and tools', async () => {
    const requestId = await seedExternalThread('req-cli-init');

    await handleIngestEvent(
      baseEvent({
        event_type: 'pipeline.cli_message',
        request_id: requestId,
        data: {
          cli_message: {
            type: 'system',
            subtype: 'init',
            session_id: 'sess-abc',
            tools: ['Read', 'Bash'],
            cwd: '/projects/app',
            model: 'sonnet',
          },
        },
      }),
    );

    expect(mocks.tm.updateThread).toHaveBeenCalledWith(
      'ingest-thread-id',
      expect.objectContaining({
        sessionId: 'sess-abc',
        status: 'running',
        initCwd: '/projects/app',
      }),
    );
    expect(mocks.wsBroker.emitToUser).toHaveBeenCalledWith(
      'u-1',
      expect.objectContaining({ type: 'agent:init' }),
    );
  });

  test('persists assistant text from CLI message', async () => {
    const requestId = await seedExternalThread('req-cli-assist');

    await handleIngestEvent(
      baseEvent({
        event_type: 'pipeline.cli_message',
        request_id: requestId,
        data: {
          cli_message: {
            type: 'assistant',
            message: {
              id: 'cli-msg-1',
              content: [{ type: 'text', text: 'Hello from agent' }],
            },
          },
        },
      }),
    );

    expect(mocks.tm.insertMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: 'ingest-thread-id',
        role: 'assistant',
        content: 'Hello from agent',
      }),
    );
    expect(mocks.wsBroker.emitToUser).toHaveBeenCalledWith(
      'u-1',
      expect.objectContaining({
        type: 'agent:message',
        data: expect.objectContaining({ role: 'assistant', content: 'Hello from agent' }),
      }),
    );
  });

  test('creates tool call from CLI assistant tool_use block', async () => {
    const requestId = await seedExternalThread('req-cli-tool');

    await handleIngestEvent(
      baseEvent({
        event_type: 'pipeline.cli_message',
        request_id: requestId,
        data: {
          cli_message: {
            type: 'assistant',
            message: {
              id: 'cli-msg-2',
              content: [{ type: 'tool_use', id: 'tu-1', name: 'Read', input: { path: '/tmp/x' } }],
            },
          },
        },
      }),
    );

    expect(mocks.tm.insertToolCall).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Read',
        input: JSON.stringify({ path: '/tmp/x' }),
      }),
    );
    expect(mocks.wsBroker.emitToUser).toHaveBeenCalledWith(
      'u-1',
      expect.objectContaining({
        type: 'agent:tool_call',
        data: expect.objectContaining({ name: 'Read' }),
      }),
    );
  });

  test('updates tool output from CLI user tool_result block', async () => {
    const requestId = await seedExternalThread('req-cli-result');

    await handleIngestEvent(
      baseEvent({
        event_type: 'pipeline.cli_message',
        request_id: requestId,
        data: {
          cli_message: {
            type: 'assistant',
            message: {
              id: 'cli-msg-3',
              content: [{ type: 'tool_use', id: 'tu-2', name: 'Bash', input: { command: 'ls' } }],
            },
          },
        },
      }),
    );

    mocks.tm.updateToolCallOutput.mockClear();
    mocks.wsBroker.emitToUser.mockClear();

    await handleIngestEvent(
      baseEvent({
        event_type: 'pipeline.cli_message',
        request_id: requestId,
        data: {
          cli_message: {
            type: 'user',
            message: {
              content: [{ type: 'tool_result', tool_use_id: 'tu-2', content: 'file.txt' }],
            },
          },
        },
      }),
    );

    expect(mocks.tm.updateToolCallOutput).toHaveBeenCalledWith('tc-1', 'file.txt');
    expect(mocks.wsBroker.emitToUser).toHaveBeenCalledWith(
      'u-1',
      expect.objectContaining({
        type: 'agent:tool_output',
        data: { toolCallId: 'tc-1', output: 'file.txt' },
      }),
    );
  });

  test('finalizes thread on CLI result success', async () => {
    const requestId = await seedExternalThread('req-cli-done');

    await handleIngestEvent(
      baseEvent({
        event_type: 'pipeline.cli_message',
        request_id: requestId,
        data: {
          cli_message: {
            type: 'result',
            subtype: 'success',
            result: 'Done',
            total_cost_usd: 0.05,
            duration_ms: 1200,
          },
        },
      }),
    );

    expect(mocks.tm.updateThread).toHaveBeenCalledWith(
      'ingest-thread-id',
      expect.objectContaining({ status: 'completed', stage: 'review', cost: 0.05 }),
    );
    expect(mocks.wsBroker.emitToUser).toHaveBeenCalledWith(
      'u-1',
      expect.objectContaining({
        type: 'agent:result',
        data: expect.objectContaining({ status: 'completed', result: 'Done' }),
      }),
    );
  });
});

describe('handleIngestEvent — session tool call/result', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrentBranch.mockResolvedValue(ok('main'));
  });

  async function seedExternalThread(requestId = 'req-tool') {
    await handleIngestEvent(
      baseEvent({
        request_id: requestId,
        metadata: { projectId: 'p-1', userId: 'u-1' },
      }),
    );
    mocks.tm.insertMessage.mockClear();
    mocks.tm.insertToolCall.mockClear();
    mocks.wsBroker.emitToUser.mockClear();
    return requestId;
  }

  test('creates tool call on session.tool_call event', async () => {
    const requestId = await seedExternalThread('req-session-tool');

    await handleIngestEvent(
      baseEvent({
        event_type: 'session.tool_call',
        request_id: requestId,
        data: {
          tool_name: 'Grep',
          tool_input: { pattern: 'foo' },
          tool_call_id: 'agent-tc-1',
        },
      }),
    );

    expect(mocks.tm.insertToolCall).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Grep',
        input: JSON.stringify({ pattern: 'foo' }),
      }),
    );
    expect(mocks.wsBroker.emitToUser).toHaveBeenCalledWith(
      'u-1',
      expect.objectContaining({
        type: 'agent:tool_call',
        data: expect.objectContaining({ name: 'Grep' }),
      }),
    );
  });

  test('updates tool output on session.tool_result event', async () => {
    const requestId = await seedExternalThread('req-session-result');

    await handleIngestEvent(
      baseEvent({
        event_type: 'session.tool_call',
        request_id: requestId,
        data: {
          tool_name: 'Grep',
          tool_input: { pattern: 'bar' },
          tool_call_id: 'agent-tc-2',
        },
      }),
    );

    mocks.tm.updateToolCallOutput.mockClear();
    mocks.wsBroker.emitToUser.mockClear();

    await handleIngestEvent(
      baseEvent({
        event_type: 'session.tool_result',
        request_id: requestId,
        data: {
          tool_call_id: 'agent-tc-2',
          output: 'match found',
        },
      }),
    );

    expect(mocks.tm.updateToolCallOutput).toHaveBeenCalledWith('tc-1', 'match found');
    expect(mocks.wsBroker.emitToUser).toHaveBeenCalledWith(
      'u-1',
      expect.objectContaining({
        type: 'agent:tool_output',
        data: { toolCallId: 'tc-1', output: 'match found' },
      }),
    );
  });

  test('updates branch and worktree on branch_set event', async () => {
    const requestId = await seedExternalThread('req-branch');

    await handleIngestEvent(
      baseEvent({
        event_type: 'session.branch_set',
        request_id: requestId,
        data: { branch: 'feature/x', worktreePath: '/wt/feature-x' },
      }),
    );

    expect(mocks.tm.updateThread).toHaveBeenCalledWith(
      'ingest-thread-id',
      expect.objectContaining({ branch: 'feature/x', worktreePath: '/wt/feature-x' }),
    );
    expect(mocks.wsBroker.emitToUser).toHaveBeenCalledWith(
      'u-1',
      expect.objectContaining({
        type: 'thread:updated',
        data: { branch: 'feature/x', worktreePath: '/wt/feature-x' },
      }),
    );
  });
});

describe('handleIngestEvent — project resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrentBranch.mockResolvedValue(ok('main'));
    mocks.tm.getThreadByExternalRequestId.mockResolvedValue(undefined);
  });

  test('auto-detects project from worktree_path prefix', async () => {
    mocks.projects.listProjects.mockResolvedValue([{ id: 'p-detected', path: '/home/dev/my-app' }]);

    const result = await handleIngestEvent(
      baseEvent({
        request_id: 'req-wt',
        metadata: { userId: 'u-1' },
        data: {
          worktree_path: '/home/dev/my-app/.funny-worktrees/my-app/feature-x',
          prompt: 'Review',
        },
      }),
    );

    expect(result.threadId).toBe('ingest-thread-id');
    expect(mocks.tm.createThread).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'p-detected',
        mode: 'worktree',
        worktreePath: '/home/dev/my-app/.funny-worktrees/my-app/feature-x',
      }),
    );
  });

  test('resolves project by GitHub repo_full_name', async () => {
    mocks.projects.listProjects.mockResolvedValue([{ id: 'p-gh', path: '/repos/backend' }]);
    mocks.getRemoteUrl.mockResolvedValue(ok('https://github.com/acme/backend.git'));

    const result = await handleIngestEvent(
      baseEvent({
        request_id: 'req-gh',
        metadata: { userId: 'u-1' },
        data: { repo_full_name: 'acme/backend', prompt: 'CI run' },
      }),
    );

    expect(result.threadId).toBe('ingest-thread-id');
    expect(mocks.tm.createThread).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'p-gh' }),
    );
  });

  test('restores thread state from externalRequestId DB lookup', async () => {
    mocks.tm.getThreadByExternalRequestId.mockResolvedValue({
      id: 't-db',
      projectId: 'p-1',
      userId: 'u-1',
    });

    await handleIngestEvent(
      baseEvent({
        event_type: 'session.started',
        request_id: 'req-db-restore',
      }),
    );

    expect(mocks.tm.updateThread).toHaveBeenCalledWith(
      't-db',
      expect.objectContaining({ status: 'running' }),
    );
  });
});

describe('handleIngestEvent — message and workflow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrentBranch.mockResolvedValue(ok('main'));
    mocks.tm.getThreadByExternalRequestId.mockResolvedValue(undefined);
  });

  async function seedThread(requestId = 'req-msg') {
    await handleIngestEvent(
      baseEvent({
        request_id: requestId,
        metadata: { projectId: 'p-1', userId: 'u-1' },
      }),
    );
    mocks.tm.insertMessage.mockClear();
    mocks.wsBroker.emitToUser.mockClear();
    return requestId;
  }

  test('persists legacy message events', async () => {
    const requestId = await seedThread('req-legacy-msg');

    await handleIngestEvent(
      baseEvent({
        event_type: 'session.message',
        request_id: requestId,
        data: { text: 'Progress update', role: 'assistant' },
      }),
    );

    expect(mocks.tm.insertMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: 'ingest-thread-id',
        role: 'assistant',
        content: 'Progress update',
      }),
    );
  });

  test('emits workflow lifecycle websocket events', async () => {
    const requestId = await seedThread('req-wf');

    await handleIngestEvent(
      baseEvent({
        event_type: 'workflow.started',
        request_id: requestId,
        data: { run_id: 'run-1', workflow_name: 'review' },
      }),
    );
    await handleIngestEvent(
      baseEvent({
        event_type: 'workflow.step.completed',
        request_id: requestId,
        data: { run_id: 'run-1', workflow_name: 'review', step_name: 'lint', output: { ok: true } },
      }),
    );
    await handleIngestEvent(
      baseEvent({
        event_type: 'workflow.completed',
        request_id: requestId,
        data: {
          run_id: 'run-1',
          workflow_name: 'review',
          quality_scores: { lint: { status: 'pass', details: '' } },
        },
      }),
    );

    expect(mocks.wsBroker.emitToUser).toHaveBeenCalledWith(
      'u-1',
      expect.objectContaining({
        type: 'workflow:status',
        data: expect.objectContaining({ status: 'running' }),
      }),
    );
    expect(mocks.wsBroker.emitToUser).toHaveBeenCalledWith(
      'u-1',
      expect.objectContaining({ type: 'workflow:step' }),
    );
    expect(mocks.wsBroker.emitToUser).toHaveBeenCalledWith(
      'u-1',
      expect.objectContaining({
        type: 'workflow:status',
        data: expect.objectContaining({ status: 'completed' }),
      }),
    );
  });

  test('emits workflow failed status', async () => {
    const requestId = await seedThread('req-wf-fail');

    await handleIngestEvent(
      baseEvent({
        event_type: 'workflow.failed',
        request_id: requestId,
        data: { run_id: 'run-2', workflow_name: 'review' },
      }),
    );

    expect(mocks.wsBroker.emitToUser).toHaveBeenCalledWith(
      'u-1',
      expect.objectContaining({
        type: 'workflow:status',
        data: expect.objectContaining({ status: 'failed' }),
      }),
    );
  });
});

describe('handleIngestEvent — CLI edge cases', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrentBranch.mockResolvedValue(ok('main'));
    mocks.tm.getThreadByExternalRequestId.mockResolvedValue(undefined);
    mocks.tm.findToolCall.mockResolvedValue(undefined);
  });

  async function seedExternalThread(requestId = 'req-cli-edge') {
    await handleIngestEvent(
      baseEvent({
        request_id: requestId,
        metadata: { projectId: 'p-1', userId: 'u-1' },
      }),
    );
    mocks.tm.updateMessage.mockClear();
    mocks.tm.insertMessage.mockClear();
    mocks.tm.insertToolCall.mockClear();
    mocks.tm.findToolCall.mockClear();
    mocks.wsBroker.emitToUser.mockClear();
    return requestId;
  }

  test('updates existing assistant message on repeated CLI chunks', async () => {
    const requestId = await seedExternalThread('req-cli-update');

    const cliPayload = {
      event_type: 'pipeline.cli_message',
      request_id: requestId,
      data: {
        cli_message: {
          type: 'assistant',
          message: {
            id: 'cli-msg-stream',
            content: [{ type: 'text', text: 'Hello' }],
          },
        },
      },
    };

    await handleIngestEvent(baseEvent(cliPayload));
    await handleIngestEvent(
      baseEvent({
        ...cliPayload,
        data: {
          cli_message: {
            type: 'assistant',
            message: {
              id: 'cli-msg-stream',
              content: [{ type: 'text', text: 'Hello world' }],
            },
          },
        },
      }),
    );

    expect(mocks.tm.updateMessage).toHaveBeenCalledWith('msg-1', 'Hello world');
  });

  test('reuses existing tool call when duplicate is detected in DB', async () => {
    const requestId = await seedExternalThread('req-cli-dup');
    mocks.tm.findToolCall.mockResolvedValue({ id: 'existing-tc' });

    await handleIngestEvent(
      baseEvent({
        event_type: 'pipeline.cli_message',
        request_id: requestId,
        data: {
          cli_message: {
            type: 'assistant',
            message: {
              id: 'cli-msg-dup',
              content: [{ type: 'tool_use', id: 'tu-dup', name: 'Read', input: { path: '/x' } }],
            },
          },
        },
      }),
    );

    expect(mocks.tm.insertToolCall).not.toHaveBeenCalled();
  });

  test('skips duplicate tool_use blocks when CLI id was already processed', async () => {
    const requestId = await seedExternalThread('req-cli-dup-id');
    const toolPayload = {
      event_type: 'pipeline.cli_message' as const,
      request_id: requestId,
      data: {
        cli_message: {
          type: 'assistant',
          message: {
            id: 'cli-msg-dup-id',
            content: [{ type: 'tool_use', id: 'tu-same', name: 'Read', input: { path: '/x' } }],
          },
        },
      },
    };

    await handleIngestEvent(baseEvent(toolPayload));
    mocks.tm.insertToolCall.mockClear();

    await handleIngestEvent(baseEvent(toolPayload));

    expect(mocks.tm.insertToolCall).not.toHaveBeenCalled();
  });

  test('decodes array-shaped CLI tool_result content blocks', async () => {
    const requestId = await seedExternalThread('req-cli-array-result');

    await handleIngestEvent(
      baseEvent({
        event_type: 'pipeline.cli_message',
        request_id: requestId,
        data: {
          cli_message: {
            type: 'assistant',
            message: {
              id: 'cli-msg-array',
              content: [{ type: 'tool_use', id: 'tu-array', name: 'Read', input: { path: '/x' } }],
            },
          },
        },
      }),
    );

    mocks.tm.updateToolCallOutput.mockClear();
    mocks.wsBroker.emitToUser.mockClear();

    await handleIngestEvent(
      baseEvent({
        event_type: 'pipeline.cli_message',
        request_id: requestId,
        data: {
          cli_message: {
            type: 'user',
            message: {
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: 'tu-array',
                  content: [
                    { type: 'text', text: 'line1' },
                    { type: 'text', text: 'line2' },
                  ],
                },
              ],
            },
          },
        },
      }),
    );

    expect(mocks.tm.updateToolCallOutput).toHaveBeenCalledWith('tc-1', 'line1\nline2');
  });

  test('finalizes failed thread on CLI result error subtype', async () => {
    const requestId = await seedExternalThread('req-cli-fail');

    await handleIngestEvent(
      baseEvent({
        event_type: 'pipeline.cli_message',
        request_id: requestId,
        data: {
          cli_message: {
            type: 'result',
            subtype: 'error',
            result: 'Agent crashed',
            total_cost_usd: 0.02,
          },
        },
      }),
    );

    expect(mocks.tm.updateThread).toHaveBeenCalledWith(
      'ingest-thread-id',
      expect.objectContaining({ status: 'failed', cost: 0.02 }),
    );
    expect(mocks.wsBroker.emitToUser).toHaveBeenCalledWith(
      'u-1',
      expect.objectContaining({
        type: 'agent:result',
        data: expect.objectContaining({ status: 'failed' }),
      }),
    );
  });

  test('skips session.completed fallback when CLI result already handled', async () => {
    const requestId = await seedExternalThread('req-cli-skip');

    await handleIngestEvent(
      baseEvent({
        event_type: 'pipeline.cli_message',
        request_id: requestId,
        data: {
          cli_message: {
            type: 'result',
            subtype: 'success',
            result: 'Done',
            total_cost_usd: 0.01,
          },
        },
      }),
    );

    mocks.tm.updateThread.mockClear();
    mocks.wsBroker.emitToUser.mockClear();

    await handleIngestEvent(
      baseEvent({
        event_type: 'session.completed',
        request_id: requestId,
        data: { cost_usd: 0.99, result: 'Should be ignored' },
      }),
    );

    expect(mocks.tm.updateThread).not.toHaveBeenCalled();
    expect(mocks.wsBroker.emitToUser).not.toHaveBeenCalled();
  });
});

describe('handleIngestEvent — accepted edge cases', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrentBranch.mockResolvedValue(ok('main'));
    mocks.tm.getThreadByExternalRequestId.mockResolvedValue(undefined);
  });

  test('throws when thread_id references a missing thread', async () => {
    mocks.tm.getThread.mockResolvedValue(null);

    await expect(
      handleIngestEvent(
        baseEvent({
          thread_id: 'missing-thread',
          data: { prompt: 'Hello' },
        }),
      ),
    ).rejects.toThrow('Thread not found: thread_id=missing-thread');
  });

  test('skips duplicate accepted events for the same request_id', async () => {
    await handleIngestEvent(
      baseEvent({
        request_id: 'req-dup',
        metadata: { projectId: 'p-1', userId: 'u-1' },
      }),
    );
    mocks.tm.createThread.mockClear();

    const result = await handleIngestEvent(
      baseEvent({
        request_id: 'req-dup',
        metadata: { projectId: 'p-1', userId: 'u-1' },
      }),
    );

    expect(result).toEqual({ threadId: undefined });
    expect(mocks.tm.createThread).not.toHaveBeenCalled();
  });

  test('throws when projectId cannot be resolved', async () => {
    mocks.projects.listProjects.mockResolvedValue([]);

    await expect(
      handleIngestEvent(
        baseEvent({
          request_id: 'req-no-project',
          metadata: { userId: 'u-1' },
          data: {},
        }),
      ),
    ).rejects.toThrow('Cannot resolve projectId');
  });

  test('drops websocket events when accepted thread has no userId', async () => {
    await handleIngestEvent(
      baseEvent({
        request_id: 'req-no-user',
        metadata: { projectId: 'p-1' },
        data: { prompt: 'Anon run' },
      }),
    );

    expect(mocks.tm.createThread).toHaveBeenCalled();
    expect(mocks.wsBroker.emitToUser).not.toHaveBeenCalled();
  });

  test('uses branch-based default title when title is omitted', async () => {
    await handleIngestEvent(
      baseEvent({
        request_id: 'req-branch-title',
        metadata: { projectId: 'p-1', userId: 'u-1' },
        data: { branch: 'feature/login' },
      }),
    );

    expect(mocks.tm.createThread).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Pipeline: feature/login' }),
    );
  });
});

describe('handleIngestEvent — lifecycle messages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrentBranch.mockResolvedValue(ok('main'));
    mocks.tm.getThreadByExternalRequestId.mockResolvedValue(undefined);
  });

  async function seedExternalThread(requestId = 'req-life-msg') {
    await handleIngestEvent(
      baseEvent({
        request_id: requestId,
        metadata: { projectId: 'p-1', userId: 'u-1' },
      }),
    );
    mocks.tm.insertMessage.mockClear();
    mocks.wsBroker.emitToUser.mockClear();
    return requestId;
  }

  test('inserts error_message assistant note on completed event', async () => {
    const requestId = await seedExternalThread('req-completed-warn');

    await handleIngestEvent(
      baseEvent({
        event_type: 'session.completed',
        request_id: requestId,
        data: { cost_usd: 0.1, result: 'Done', error_message: 'Minor warning' },
      }),
    );

    expect(mocks.tm.insertMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        role: 'assistant',
        content: 'Minor warning',
      }),
    );
  });

  test('ignores branch_set events with no branch or worktree path', async () => {
    const requestId = await seedExternalThread('req-branch-empty');

    await handleIngestEvent(
      baseEvent({
        event_type: 'session.branch_set',
        request_id: requestId,
        data: {},
      }),
    );

    expect(mocks.tm.updateThread).not.toHaveBeenCalled();
  });

  test('ignores session.tool_result when tool call mapping is missing', async () => {
    const requestId = await seedExternalThread('req-tool-missing');

    await handleIngestEvent(
      baseEvent({
        event_type: 'session.tool_result',
        request_id: requestId,
        data: { tool_call_id: 'unknown', output: 'ignored' },
      }),
    );

    expect(mocks.tm.updateToolCallOutput).not.toHaveBeenCalled();
  });
});

describe('startExternalThreadSweep', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mocks.getCurrentBranch.mockResolvedValue(ok('main'));
    mocks.tm.getThreadByExternalRequestId.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    const registered = vi
      .mocked(shutdownManager.register)
      .mock.calls.find(([name]) => name === 'ingest-sweep');
    await registered?.[1]?.();
    vi.useRealTimers();
  });

  test('starts periodic stale-thread sweep once', async () => {
    startExternalThreadSweep();
    startExternalThreadSweep();

    await handleIngestEvent(
      baseEvent({
        request_id: 'req-sweep-timer',
        metadata: { projectId: 'p-1', userId: 'u-1' },
      }),
    );

    vi.advanceTimersByTime(11 * 60 * 1000);
    await vi.advanceTimersByTimeAsync(2 * 60 * 1000);

    expect(mocks.tm.updateThread).toHaveBeenCalledWith(
      'ingest-thread-id',
      expect.objectContaining({ status: 'stopped' }),
    );
  });

  test('clears sweep timer on shutdown cleanup', async () => {
    startExternalThreadSweep();

    const registered = vi
      .mocked(shutdownManager.register)
      .mock.calls.find(([name]) => name === 'ingest-sweep');
    await registered?.[1]?.();

    startExternalThreadSweep();
    await handleIngestEvent(
      baseEvent({
        request_id: 'req-after-shutdown',
        metadata: { projectId: 'p-1', userId: 'u-1' },
      }),
    );

    vi.advanceTimersByTime(11 * 60 * 1000);
    mocks.tm.updateThread.mockClear();
    await vi.advanceTimersByTimeAsync(2 * 60 * 1000);

    expect(mocks.tm.updateThread).not.toHaveBeenCalled();
  });
});

describe('sweepStaleExternalThreads', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mocks.getCurrentBranch.mockResolvedValue(ok('main'));
    mocks.tm.getThreadByExternalRequestId.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('stops threads with no recent ingest activity', async () => {
    await handleIngestEvent(
      baseEvent({
        request_id: 'req-stale',
        metadata: { projectId: 'p-1', userId: 'u-1' },
      }),
    );

    vi.advanceTimersByTime(11 * 60 * 1000);
    mocks.tm.updateThread.mockClear();
    mocks.wsBroker.emitToUser.mockClear();

    await sweepStaleExternalThreads();

    expect(mocks.tm.updateThread).toHaveBeenCalledWith(
      'ingest-thread-id',
      expect.objectContaining({ status: 'stopped' }),
    );
    expect(mocks.wsBroker.emitToUser).toHaveBeenCalledWith(
      'u-1',
      expect.objectContaining({
        type: 'agent:status',
        data: { status: 'stopped' },
      }),
    );
  });
});
