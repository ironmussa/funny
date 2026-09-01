import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';

import { resolveRunnerGrpcConfig } from '../../services/grpc/config.js';
import type {
  RunnerGrpcCall,
  RunnerGrpcCallContext,
} from '../../services/grpc/runner-grpc-server.js';
import { RunnerGrpcSessionRegistry } from '../../services/grpc/session-registry.js';
import {
  createTerminalHandler,
  RunnerGrpcTerminalDispatcher,
} from '../../services/grpc/terminal-handler.js';

class FakeCall extends EventEmitter {
  readonly writes: Array<Record<string, any>> = [];

  write(frame: Record<string, unknown>): boolean {
    this.writes.push(frame);
    return true;
  }
}

const context: RunnerGrpcCallContext = {
  correlationId: 'terminal-stream',
  method: 'terminal',
  principal: { runnerId: 'runner-1', userId: 'user-1', tenantId: 'user-1' },
};

function setup() {
  const config = {
    ...resolveRunnerGrpcConfig({ RUNNER_GRPC_ENABLED: 'true' }),
    heartbeatTimeoutMs: 60_000,
    maxActiveTerminals: 2,
    maxFrameBytes: 8,
  };
  const sessions = new RunnerGrpcSessionRegistry({ heartbeatTimeoutMs: 60_000 });
  const epoch = sessions.activate('runner-1', { invalidate: () => {} });
  const relayed: Array<Record<string, unknown>> = [];
  const dispatcher = new RunnerGrpcTerminalDispatcher(config, sessions, (_userId, event) => {
    relayed.push(event);
  });
  const call = new FakeCall();
  createTerminalHandler(config, sessions, { dispatcher })(
    call as unknown as RunnerGrpcCall,
    context,
  );
  call.emit('data', { session: { sessionEpoch: String(epoch) }, ready: {} });
  return { call, dispatcher, epoch, relayed, sessions };
}

describe('runner gRPC terminal stream', () => {
  test('delivers input once, sequences output, and resumes from the last browser sequence', () => {
    const { call, dispatcher, epoch, relayed, sessions } = setup();

    dispatcher.dispatch('runner-1', 'user-1', {
      type: 'pty:spawn',
      data: { id: 'pty-1', cwd: '/repo', cols: 100, rows: 30 },
    });
    dispatcher.dispatch('runner-1', 'user-1', {
      type: 'pty:write',
      data: { id: 'pty-1', data: 'echo ok\n' },
    });

    expect(call.writes[0]?.open).toMatchObject({
      terminalId: 'pty-1',
      cwd: '/repo',
      columns: 100,
      rows: 30,
    });
    expect(call.writes[1]?.input.ordinal).toBe('1');
    expect(Buffer.from(call.writes[1]?.input.data).toString()).toBe('echo ok\n');

    call.emit('data', {
      session: { sessionEpoch: String(epoch) },
      terminalId: 'pty-1',
      output: { sequence: '1', data: Uint8Array.from([111, 107]) },
    });
    dispatcher.dispatch('runner-1', 'user-1', {
      type: 'pty:restore',
      data: { id: 'pty-1' },
    });

    expect(relayed).toEqual([
      {
        type: 'pty:data',
        threadId: '',
        data: { ptyId: 'pty-1', data: 'ok' },
      },
    ]);
    expect(call.writes.at(-1)?.resume).toEqual({
      terminalId: 'pty-1',
      lastSeenOutputSequence: '1',
    });
    expect(call.writes.filter((frame) => frame.input)).toHaveLength(1);
    sessions.closeAll();
  });

  test('preserves browser text semantics when UTF-8 output spans gRPC frames', () => {
    const { call, dispatcher, epoch, relayed, sessions } = setup();
    dispatcher.dispatch('runner-1', 'user-1', {
      type: 'pty:spawn',
      data: { id: 'pty-1', cwd: '/repo' },
    });
    const encoded = new TextEncoder().encode('€');

    call.emit('data', {
      session: { sessionEpoch: String(epoch) },
      terminalId: 'pty-1',
      output: { sequence: '1', data: encoded.subarray(0, 2) },
    });
    call.emit('data', {
      session: { sessionEpoch: String(epoch) },
      terminalId: 'pty-1',
      output: { sequence: '2', data: encoded.subarray(2) },
    });

    expect(relayed).toEqual([
      {
        type: 'pty:data',
        threadId: '',
        data: { ptyId: 'pty-1', data: '€' },
      },
    ]);
    sessions.closeAll();
  });

  test('keeps terminal state across stream replacement and never replays prior input', () => {
    const { call: firstCall, dispatcher, epoch, sessions } = setup();
    dispatcher.dispatch('runner-1', 'user-1', {
      type: 'pty:spawn',
      data: { id: 'pty-1', cwd: '/repo', cols: 80, rows: 24 },
    });
    dispatcher.dispatch('runner-1', 'user-1', {
      type: 'pty:write',
      data: { id: 'pty-1', data: 'pwd\n' },
    });

    const replacement = new FakeCall();
    createTerminalHandler(
      { ...resolveRunnerGrpcConfig({ RUNNER_GRPC_ENABLED: 'true' }), heartbeatTimeoutMs: 60_000 },
      sessions,
      { dispatcher },
    )(replacement as unknown as RunnerGrpcCall, context);
    replacement.emit('data', { session: { sessionEpoch: String(epoch) }, ready: {} });
    dispatcher.dispatch('runner-1', 'user-1', {
      type: 'pty:reconnect',
      data: { id: 'pty-1' },
    });

    expect(firstCall.writes.filter((frame) => frame.input)).toHaveLength(1);
    expect(replacement.writes.filter((frame) => frame.input)).toHaveLength(0);
    expect(replacement.writes.at(-1)?.resume.lastSeenOutputSequence).toBe('0');
    sessions.closeAll();
  });

  test('coalesces resize bursts and enforces terminal and frame limits', async () => {
    const { call, dispatcher, sessions } = setup();
    dispatcher.dispatch('runner-1', 'user-1', {
      type: 'pty:spawn',
      data: { id: 'pty-1', cwd: '/repo' },
    });
    dispatcher.dispatch('runner-1', 'user-1', {
      type: 'pty:resize',
      data: { id: 'pty-1', cols: 90, rows: 20 },
    });
    dispatcher.dispatch('runner-1', 'user-1', {
      type: 'pty:resize',
      data: { id: 'pty-1', cols: 120, rows: 40 },
    });
    await Promise.resolve();

    expect(call.writes.filter((frame) => frame.resize)).toEqual([
      expect.objectContaining({ resize: { columns: 120, rows: 40 } }),
    ]);
    expect(() =>
      dispatcher.dispatch('runner-1', 'user-1', {
        type: 'pty:write',
        data: { id: 'pty-1', data: '123456789' },
      }),
    ).toThrow('terminal input exceeds negotiated frame limit');

    dispatcher.dispatch('runner-1', 'user-1', {
      type: 'pty:spawn',
      data: { id: 'pty-2', cwd: '/repo' },
    });
    expect(() =>
      dispatcher.dispatch('runner-1', 'user-1', {
        type: 'pty:spawn',
        data: { id: 'pty-3', cwd: '/repo' },
      }),
    ).toThrow('runner terminal limit exceeded');
    sessions.closeAll();
  });
});
