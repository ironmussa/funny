import { EventEmitter } from 'node:events';

import { fromJson } from '@bufbuild/protobuf';
import { FailureCode } from '@funny/shared/runner-v2/common';
import { OperationsRequestSchema } from '@funny/shared/runner-v2/operations';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { GrpcEventReplayStore } from '../../services/grpc-event-replay-store.js';
import { GrpcOperationOutbox } from '../../services/grpc-operation-outbox.js';
import type {
  RunnerGrpcDuplexStream,
  RunnerGrpcTransport,
  RunnerGrpcWireMessage,
} from '../../services/grpc-runner-client.js';
import { GrpcTeamTransport, type GrpcTerminalCommand } from '../../services/grpc-team-transport.js';
import { GrpcTerminalReplayStore } from '../../services/grpc-terminal-replay-store.js';

class FakeStream extends EventEmitter implements RunnerGrpcDuplexStream {
  readonly writes: RunnerGrpcWireMessage[] = [];

  write(message: RunnerGrpcWireMessage): boolean {
    this.writes.push(message);
    return true;
  }

  end(): void {}
  cancel(): void {}

  override on(event: string, listener: (...args: any[]) => void): this {
    return super.on(event, listener);
  }
}

class FakeTransport implements RunnerGrpcTransport {
  readonly streams = new Map<string, FakeStream>();

  open(name: 'control' | 'operations' | 'events' | 'tunnel' | 'terminal'): FakeStream {
    const stream = new FakeStream();
    this.streams.set(name, stream);
    return stream;
  }

  close(): void {}
}

function createHarness(
  overrides: {
    outbox?: GrpcOperationOutbox;
    handleTunnel?: (request: Request, signal: AbortSignal) => Promise<Response>;
    handleTerminal?: (command: GrpcTerminalCommand, respond: (event: any) => void) => void;
  } = {},
) {
  const wire = new FakeTransport();
  const outbox = overrides.outbox ?? new GrpcOperationOutbox(':memory:');
  const adapter = new GrpcTeamTransport({
    endpoint: 'grpc.example.test:50051',
    token: 'runner-token',
    runner: {
      instanceId: 'runner-1',
      name: 'runner',
      hostname: 'runner-host',
      operatingSystem: 'linux',
    },
    transportFactory: () => wire,
    outbox,
    events: new GrpcEventReplayStore(':memory:'),
    terminals: new GrpcTerminalReplayStore(),
    handleTunnel: overrides.handleTunnel,
    handleTerminal: overrides.handleTerminal,
  });
  return { adapter, outbox, wire };
}

function activate(wire: FakeTransport, epoch = '7'): void {
  wire.streams.get('control')?.emit('data', {
    hello: {
      sessionEpoch: epoch,
      effectiveLimits: { maxFrameBytes: 4 },
    },
  });
}

async function flushMicrotasksUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100 && !predicate(); attempt += 1) {
    await Promise.resolve();
  }
}

describe('GrpcTeamTransport', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test('queues a pre-activation mutation once and confirms its durable outcome', async () => {
    const { adapter, outbox, wire } = createHarness();
    adapter.start();

    const result = adapter.request('data:insert_message', {
      payload: { threadId: 'thread-1', content: 'hello' },
    });
    expect(outbox.pending()).toHaveLength(1);

    activate(wire);
    const operations = wire.streams.get('operations')!;
    expect(operations.writes).toHaveLength(1);
    expect(operations.writes[0]).toMatchObject({
      session: { sessionEpoch: '7' },
      metadata: { idempotencyKey: expect.any(String) },
      insertMessage: { threadId: 'thread-1', content: 'hello' },
    });

    operations.emit('data', {
      correlationId: operations.writes[0]!.metadata.correlationId,
      success: { insertedRecord: { id: 'message-1' } },
    });
    await expect(result).resolves.toEqual({ messageId: 'message-1' });
    expect(outbox.pending()).toEqual([]);
    adapter.shutdown();
  });

  test('starts the operation timeout when a queued request is sent after activation', async () => {
    const { adapter, wire } = createHarness();
    adapter.start();

    const result = adapter.request('data:get_project', { projectId: 'project-1' });
    vi.advanceTimersByTime(14_000);
    activate(wire);
    vi.advanceTimersByTime(2_000);

    const operations = wire.streams.get('operations')!;
    expect(operations.writes).toHaveLength(1);
    operations.emit('data', {
      correlationId: operations.writes[0]!.metadata.correlationId,
      success: { operationResponse: { type: 'data:get_project_response', project: null } },
    });

    await expect(result).resolves.toEqual({
      type: 'data:get_project_response',
      project: null,
    });
    adapter.shutdown();
  });

  test('removes a durable mutation after a typed failure', async () => {
    const { adapter, outbox, wire } = createHarness();
    adapter.start();
    activate(wire);

    const result = adapter.request('data:update_thread', {
      payload: { threadId: 'thread-1', updates: { status: 'completed' } },
    });
    const sent = wire.streams.get('operations')!.writes[0]!;
    wire.streams.get('operations')!.emit('data', {
      correlationId: sent.metadata.correlationId,
      failure: { code: 3, message: 'invalid transition', retryable: false },
    });

    await expect(result).rejects.toThrow('invalid transition');
    expect(outbox.pending()).toEqual([]);
    adapter.shutdown();
  });

  test('preserves nullable lookup semantics for a typed not-found response', async () => {
    const { adapter, wire } = createHarness();
    adapter.start();
    activate(wire);

    const result = adapter.request('data:get_thread_by_session_id', {
      sessionId: 'missing-session',
    });
    const sent = wire.streams.get('operations')!.writes[0]!;
    wire.streams.get('operations')!.emit('data', {
      correlationId: sent.metadata.correlationId,
      failure: {
        code: FailureCode.NOT_FOUND,
        message: 'authorized resource was not found',
        retryable: false,
      },
    });

    await expect(result).resolves.toEqual({
      type: 'data:get_thread_response',
      thread: null,
    });
    adapter.shutdown();
  });

  test('removes undefined fields before encoding a thread creation Struct', async () => {
    const { adapter, wire } = createHarness();
    adapter.start();
    activate(wire);

    const result = adapter.request('data:create_thread', {
      payload: {
        id: 'thread-1',
        projectId: 'project-1',
        title: 'New thread',
        branch: undefined,
        worktreePath: undefined,
        metadata: { source: 'web', optional: undefined },
      },
    });
    const operations = wire.streams.get('operations')!;
    const sent = operations.writes[0]!;

    expect(sent.createThread.thread).toEqual({
      id: 'thread-1',
      projectId: 'project-1',
      title: 'New thread',
      metadata: { source: 'web' },
    });
    expect(() => fromJson(OperationsRequestSchema, sent)).not.toThrow();
    operations.emit('data', {
      correlationId: sent.metadata.correlationId,
      success: { operationResponse: { type: 'data:ack', success: true } },
    });
    await expect(result).resolves.toEqual({ type: 'data:ack', success: true });
    adapter.shutdown();
  });

  test('translates legacy message images when replaying a persisted outbox row', async () => {
    const outbox = new GrpcOperationOutbox(':memory:');
    outbox.enqueue({
      idempotencyKey: '_legacy-message-key',
      operationKind: 'insertMessage',
      payload: {
        threadId: 'thread-1',
        role: 'user',
        content: 'hello',
        images: '[{"mediaType":"image/png","data":"abc"}]',
      },
    });
    const { adapter, wire } = createHarness({ outbox });
    adapter.start();
    activate(wire);

    const operations = wire.streams.get('operations')!;
    const sent = operations.writes[0]!;
    expect(sent.insertMessage).toEqual({
      threadId: 'thread-1',
      role: 'user',
      content: 'hello',
      imagesJson: '[{"mediaType":"image/png","data":"abc"}]',
    });
    expect(() => fromJson(OperationsRequestSchema, sent)).not.toThrow();

    operations.emit('data', {
      correlationId: sent.metadata.correlationId,
      success: { insertedRecord: { id: 'message-1' } },
    });
    expect(outbox.pending()).toEqual([]);
    adapter.shutdown();
  });

  test('removes legacy user IDs from permission-rule operations', async () => {
    const { adapter, wire } = createHarness();
    adapter.start();
    activate(wire);

    const requests = [
      adapter.request('data:create_permission_rule', {
        payload: {
          userId: 'legacy-user',
          projectPath: '/project',
          toolName: 'Bash',
          pattern: null,
          decision: 'allow',
        },
      }),
      adapter.request('data:find_permission_rule', {
        payload: {
          userId: 'legacy-user',
          projectPath: '/project',
          toolName: 'Bash',
          toolInput: 'pwd',
        },
      }),
      adapter.request('data:list_permission_rules', {
        payload: { userId: 'legacy-user', projectPath: '/project' },
      }),
    ];
    const operations = wire.streams.get('operations')!;

    expect(operations.writes[0]!.createPermissionRule).toEqual({
      projectPath: '/project',
      toolName: 'Bash',
      decision: 'allow',
    });
    expect(operations.writes[1]!.findPermissionRule).toEqual({
      projectPath: '/project',
      toolName: 'Bash',
      toolInput: 'pwd',
    });
    expect(operations.writes[2]!.listPermissionRules).toEqual({ projectPath: '/project' });

    for (const sent of operations.writes) {
      expect(() => fromJson(OperationsRequestSchema, sent)).not.toThrow();
      operations.emit('data', {
        correlationId: sent.metadata.correlationId,
        success: { operationResponse: { type: 'data:ack', success: true } },
      });
    }
    await expect(Promise.all(requests)).resolves.toHaveLength(3);
    adapter.shutdown();
  });

  test('sequences agent events and acknowledges the replay scope', () => {
    const { adapter, wire } = createHarness();
    adapter.start();
    activate(wire);

    adapter.publish({ type: 'agent:init', threadId: 'thread-1', data: {} } as any);
    adapter.publish({ type: 'agent:result', threadId: 'thread-1', data: { text: 'done' } } as any);
    const events = wire.streams.get('events')!;
    expect(events.writes.map((frame) => frame.sequence)).toEqual(['1', '2']);
    expect(events.writes[1]).toMatchObject({
      event: { eventType: 'agent:result', durability: 3 },
    });

    events.emit('data', {
      scope: events.writes[1]!.scope,
      accepted: { highestContiguousSequence: '2' },
    });
    adapter.shutdown();
  });

  test('translates framed tunnel requests and chunks the local response', async () => {
    const handleTunnel = vi.fn(async (request: Request) => {
      expect(request.method).toBe('POST');
      expect(request.headers.get('x-test')).toBe('yes');
      expect(await request.text()).toBe('hello');
      return new Response('response', { status: 201, headers: { 'x-result': 'ok' } });
    });
    const { adapter, wire } = createHarness({ handleTunnel });
    adapter.start();
    activate(wire);
    const tunnel = wire.streams.get('tunnel')!;

    tunnel.emit('data', {
      tunnelId: 'tunnel-1',
      requestStart: {
        method: 'POST',
        path: '/api/test',
        headers: [{ name: 'x-test', value: 'yes' }],
      },
    });
    tunnel.emit('data', {
      tunnelId: 'tunnel-1',
      data: { sequence: '1', data: Buffer.from('hell').toString('base64') },
    });
    tunnel.emit('data', {
      tunnelId: 'tunnel-1',
      data: { sequence: '2', data: Buffer.from('o').toString('base64') },
    });
    tunnel.emit('data', { tunnelId: 'tunnel-1', end: { finalSequence: '2' } });
    expect(handleTunnel).toHaveBeenCalledOnce();
    await handleTunnel.mock.results[0]!.value;
    // Let respondToTunnel resume after awaiting the mocked response and drain
    // its body before inspecting the emitted frames. Bun's test runner does
    // not implement Vitest's vi.waitFor helper.
    await flushMicrotasksUntil(() => Boolean(tunnel.writes.at(-1)?.end));
    expect(tunnel.writes.at(-1)).toMatchObject({ end: { finalSequence: '2' } });
    expect(tunnel.writes.filter((frame) => frame.data).map((frame) => frame.data.sequence)).toEqual(
      ['1', '2'],
    );
    adapter.shutdown();
  });

  test('applies terminal input at most once and sequences returned output', () => {
    const commands: GrpcTerminalCommand[] = [];
    let respond: ((event: any) => void) | undefined;
    const { adapter, wire } = createHarness({
      handleTerminal: (command, send) => {
        commands.push(command);
        respond = send;
      },
    });
    adapter.start();
    activate(wire);
    const terminal = wire.streams.get('terminal')!;

    terminal.emit('data', {
      terminalId: 'pty-1',
      open: { userId: 'user-1', cwd: '/tmp', columns: 80, rows: 24 },
    });
    const input = {
      terminalId: 'pty-1',
      input: { ordinal: '1', data: Buffer.from('ls\n').toString('base64') },
    };
    terminal.emit('data', input);
    terminal.emit('data', input);

    expect(commands.map((command) => command.type)).toEqual(['pty:spawn', 'pty:write']);
    expect(commands[1]!.data.data).toBe('ls\n');
    respond?.({ type: 'pty:data', data: { ptyId: 'pty-1', data: 'output' } });
    expect(terminal.writes.at(-1)).toMatchObject({
      terminalId: 'pty-1',
      output: { sequence: '2' },
    });
    adapter.shutdown();
  });
});
