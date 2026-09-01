import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';

import { FailureCode } from '@funny/shared/runner-v2/common';

import { resolveRunnerGrpcConfig } from '../../services/grpc/config.js';
import type {
  RunnerGrpcCall,
  RunnerGrpcCallContext,
} from '../../services/grpc/runner-grpc-server.js';
import { RunnerGrpcSessionRegistry } from '../../services/grpc/session-registry.js';
import {
  createTunnelHandler,
  RunnerGrpcTunnelDispatcher,
  TunnelDispatchError,
} from '../../services/grpc/tunnel-handler.js';

class FakeCall extends EventEmitter {
  readonly writes: Array<Record<string, any>> = [];

  write(frame: Record<string, unknown>): boolean {
    this.writes.push(frame);
    return true;
  }
}

const context: RunnerGrpcCallContext = {
  correlationId: 'stream-correlation',
  method: 'tunnel',
  principal: { runnerId: 'runner-1', userId: 'user-1', tenantId: 'user-1' },
};

function setup(overrides: Partial<ReturnType<typeof resolveRunnerGrpcConfig>> = {}) {
  const config = {
    ...resolveRunnerGrpcConfig({ RUNNER_GRPC_ENABLED: 'true' }),
    heartbeatTimeoutMs: 60_000,
    ...overrides,
  };
  const sessions = new RunnerGrpcSessionRegistry({ heartbeatTimeoutMs: 60_000 });
  const epoch = sessions.activate('runner-1', { invalidate: () => {} });
  const dispatcher = new RunnerGrpcTunnelDispatcher(config, sessions);
  const call = new FakeCall();
  createTunnelHandler(config, sessions, { dispatcher })(call as unknown as RunnerGrpcCall, context);
  call.emit('data', { session: { sessionEpoch: String(epoch) }, ready: {} });
  return { call, dispatcher, epoch, sessions };
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (condition()) return;
    await Bun.sleep(1);
  }
  throw new Error('condition was not met');
}

describe('runner gRPC tunnel stream', () => {
  test('frames binary request bodies and yields ordered binary response bodies', async () => {
    const { call, dispatcher, epoch, sessions } = setup({ maxFrameBytes: 2 });
    const exchange = dispatcher.dispatch('runner-1', {
      method: 'POST',
      path: '/upload',
      headers: [{ name: 'content-type', value: 'application/octet-stream' }],
      body: Uint8Array.from([1, 2, 3, 4, 5]),
      deadlineAt: Date.now() + 10_000,
      correlationId: 'tunnel-1',
    });

    await waitFor(() => call.writes.length === 5);
    expect(
      call.writes.map((frame) => (frame.requestStart ? 'start' : frame.data ? 'data' : 'end')),
    ).toEqual(['start', 'data', 'data', 'data', 'end']);
    expect(call.writes.slice(1, 4).map((frame) => [...frame.data.data])).toEqual([
      [1, 2],
      [3, 4],
      [5],
    ]);
    expect(call.writes.slice(1, 4).map((frame) => frame.data.sequence)).toEqual(['1', '2', '3']);
    expect(call.writes[4]?.end.finalSequence).toBe('3');

    call.emit('data', {
      session: { sessionEpoch: String(epoch) },
      tunnelId: exchange.tunnelId,
      responseStart: { statusCode: 201, headers: [{ name: 'x-result', value: 'ok' }] },
    });
    call.emit('data', {
      session: { sessionEpoch: String(epoch) },
      tunnelId: exchange.tunnelId,
      data: { sequence: '1', data: Uint8Array.from([9, 8]) },
    });
    call.emit('data', {
      session: { sessionEpoch: String(epoch) },
      tunnelId: exchange.tunnelId,
      data: { sequence: '2', data: Uint8Array.from([7]) },
    });
    call.emit('data', {
      session: { sessionEpoch: String(epoch) },
      tunnelId: exchange.tunnelId,
      end: { finalSequence: '2' },
    });

    expect(await exchange.response).toEqual({
      statusCode: 201,
      headers: [{ name: 'x-result', value: 'ok' }],
    });
    const responseBody: number[] = [];
    for await (const chunk of exchange.body) responseBody.push(...chunk);
    expect(responseBody).toEqual([9, 8, 7]);
    await expect(exchange.completed).resolves.toBeUndefined();
    sessions.closeAll();
  });

  test('streams large uploads and downloads without changing binary bytes', async () => {
    const frameBytes = 64 * 1024;
    const payload = Uint8Array.from({ length: frameBytes * 4 }, (_value, index) => index % 251);
    const { call, dispatcher, epoch, sessions } = setup({
      maxFrameBytes: frameBytes,
      maxBufferedBytesPerClass: payload.byteLength,
    });
    const exchange = dispatcher.dispatch('runner-1', {
      method: 'PUT',
      path: '/large-binary',
      body: payload,
      deadlineAt: Date.now() + 10_000,
    });

    await waitFor(() => call.writes.some((frame) => frame.end));
    const uploadFrames = call.writes.filter((frame) => frame.data);
    expect(uploadFrames).toHaveLength(4);
    expect(Buffer.concat(uploadFrames.map((frame) => Buffer.from(frame.data.data)))).toEqual(
      Buffer.from(payload),
    );

    call.emit('data', {
      session: { sessionEpoch: String(epoch) },
      tunnelId: exchange.tunnelId,
      responseStart: { statusCode: 200 },
    });
    for (let index = 0; index < 4; index += 1) {
      call.emit('data', {
        session: { sessionEpoch: String(epoch) },
        tunnelId: exchange.tunnelId,
        data: {
          sequence: String(index + 1),
          data: payload.subarray(index * frameBytes, (index + 1) * frameBytes),
        },
      });
    }
    call.emit('data', {
      session: { sessionEpoch: String(epoch) },
      tunnelId: exchange.tunnelId,
      end: { finalSequence: '4' },
    });

    const download: Uint8Array[] = [];
    for await (const chunk of exchange.body) download.push(chunk);
    expect(Buffer.concat(download.map((chunk) => Buffer.from(chunk)))).toEqual(
      Buffer.from(payload),
    );
    await expect(exchange.completed).resolves.toBeUndefined();
    sessions.closeAll();
  });

  test('cancels only the affected tunnel when a slow consumer exhausts its buffer', async () => {
    const { call, dispatcher, epoch, sessions } = setup({
      maxFrameBytes: 4,
      maxBufferedBytesPerClass: 2,
    });
    const exchange = dispatcher.dispatch('runner-1', {
      method: 'GET',
      path: '/large',
      deadlineAt: Date.now() + 10_000,
    });
    call.emit('data', {
      session: { sessionEpoch: String(epoch) },
      tunnelId: exchange.tunnelId,
      responseStart: { statusCode: 200 },
    });
    call.emit('data', {
      session: { sessionEpoch: String(epoch) },
      tunnelId: exchange.tunnelId,
      data: { sequence: '1', data: Uint8Array.from([1, 2, 3]) },
    });

    await expect(exchange.completed).rejects.toMatchObject({
      name: 'TunnelDispatchError',
      code: FailureCode.RESOURCE_EXHAUSTED,
    });
    expect(call.writes.at(-1)?.cancel.reason).toContain('buffer exceeds');

    const next = dispatcher.dispatch('runner-1', {
      method: 'GET',
      path: '/still-available',
      deadlineAt: Date.now() + 10_000,
    });
    expect(next.tunnelId).not.toBe(exchange.tunnelId);
    next.cancel();
    await expect(next.completed).rejects.toBeInstanceOf(TunnelDispatchError);
    sessions.closeAll();
  });

  test('rejects out-of-order frames and propagates caller cancellation', async () => {
    const { call, dispatcher, epoch, sessions } = setup();
    const controller = new AbortController();
    const invalid = dispatcher.dispatch('runner-1', {
      method: 'GET',
      path: '/ordered',
      deadlineAt: Date.now() + 10_000,
    });
    call.emit('data', {
      session: { sessionEpoch: String(epoch) },
      tunnelId: invalid.tunnelId,
      responseStart: { statusCode: 200 },
    });
    call.emit('data', {
      session: { sessionEpoch: String(epoch) },
      tunnelId: invalid.tunnelId,
      data: { sequence: '2', data: Uint8Array.from([1]) },
    });
    await expect(invalid.completed).rejects.toMatchObject({ code: FailureCode.INVALID_ARGUMENT });
    await expect(
      (async () => {
        for await (const chunk of invalid.body) {
          // The invalid sequence must surface through the body iterator too.
          void chunk;
        }
      })(),
    ).rejects.toMatchObject({ code: FailureCode.INVALID_ARGUMENT });

    const cancelled = dispatcher.dispatch('runner-1', {
      method: 'GET',
      path: '/cancelled',
      deadlineAt: Date.now() + 10_000,
      signal: controller.signal,
    });
    controller.abort();
    await expect(cancelled.response).rejects.toMatchObject({ code: FailureCode.CANCELLED });
    await expect(cancelled.completed).rejects.toMatchObject({ code: FailureCode.CANCELLED });
    expect(call.writes.at(-1)?.cancel.reason).toBe('tunnel request cancelled');
    sessions.closeAll();
  });
});
