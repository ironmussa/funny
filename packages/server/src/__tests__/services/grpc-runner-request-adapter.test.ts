import { describe, expect, test } from 'bun:test';

import { FailureCode } from '@funny/shared/runner-v2/common';

import { GrpcRunnerRequestAdapter } from '../../services/grpc/runner-request-adapter.js';
import { TunnelDispatchError } from '../../services/grpc/tunnel-handler.js';
import { RunnerRequestTimeoutError } from '../../services/runner-ports.js';

function adapterWith(
  dispatch: (runnerId: string, request: any) => any,
  isConnected = () => true,
): GrpcRunnerRequestAdapter {
  return new GrpcRunnerRequestAdapter({ isConnected, dispatch } as any);
}

describe('GrpcRunnerRequestAdapter', () => {
  test('rejects when no active gRPC tunnel exists', async () => {
    const adapter = adapterWith(
      () => undefined,
      () => false,
    );
    await expect(
      adapter.request('r1', { method: 'GET', path: '/api/health', headers: {} }),
    ).rejects.toThrow(/no active gRPC tunnel/);
  });

  test('preserves response shape, request bytes, and deadlines', async () => {
    const requests: any[] = [];
    const adapter = adapterWith((_runnerId, request) => {
      requests.push(request);
      return {
        response: Promise.resolve({
          statusCode: 201,
          headers: [{ name: 'content-type', value: 'application/json' }],
        }),
        body: (async function* () {
          yield Buffer.from('{"ok":');
          yield Buffer.from('true}');
        })(),
        completed: Promise.resolve(),
      };
    });

    await expect(
      adapter.request('r1', {
        method: 'POST',
        path: '/api/tasks',
        headers: { 'content-type': 'application/json' },
        body: '{"name":"test"}',
        deadlineAt: 123_456,
      }),
    ).resolves.toEqual({
      status: 201,
      headers: { 'content-type': 'application/json' },
      body: '{"ok":true}',
      bodyEncoding: 'utf8',
    });
    expect(requests[0]).toMatchObject({
      body: Uint8Array.from(Buffer.from('{"name":"test"}')),
      deadlineAt: 123_456,
    });
  });

  test('preserves binary uploads and base64-encodes binary responses', async () => {
    const upload = Uint8Array.from([0, 0xff, 0xfe, 0x80, 1]);
    const responseBytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0xff]);
    let requestBody: Uint8Array | undefined;
    const adapter = adapterWith((_runnerId, request) => {
      requestBody = request.body;
      return {
        response: Promise.resolve({
          statusCode: 200,
          headers: [{ name: 'content-type', value: 'image/png' }],
        }),
        body: (async function* () {
          yield responseBytes;
        })(),
        completed: Promise.resolve(),
      };
    });

    await expect(
      adapter.request('r1', {
        method: 'POST',
        path: '/image.png',
        headers: {},
        body: upload,
      }),
    ).resolves.toEqual({
      status: 200,
      headers: { 'content-type': 'image/png' },
      body: Buffer.from(responseBytes).toString('base64'),
      bodyEncoding: 'base64',
    });
    expect(requestBody).toEqual(upload);
  });

  test('waits for tunnel capacity instead of failing a burst request', async () => {
    let attempts = 0;
    const adapter = adapterWith(() => {
      attempts += 1;
      if (attempts < 3) {
        throw new TunnelDispatchError(
          'active tunnel limit exceeded',
          FailureCode.RESOURCE_EXHAUSTED,
          true,
        );
      }
      return {
        response: Promise.resolve({
          statusCode: 200,
          headers: [{ name: 'content-type', value: 'application/json' }],
        }),
        body: (async function* () {
          yield Buffer.from('{"entries":[]}');
        })(),
        completed: Promise.resolve(),
      };
    });

    await expect(
      adapter.request('r1', {
        method: 'GET',
        path: '/api/git/thread-1/log',
        headers: {},
        deadlineAt: Date.now() + 1_000,
      }),
    ).resolves.toMatchObject({ status: 200, body: '{"entries":[]}' });
    expect(attempts).toBe(3);
  });

  test('stops waiting for tunnel capacity when the caller cancels', async () => {
    let attempts = 0;
    const adapter = adapterWith(() => {
      attempts += 1;
      throw new TunnelDispatchError(
        'active tunnel limit exceeded',
        FailureCode.RESOURCE_EXHAUSTED,
        true,
      );
    });
    const controller = new AbortController();
    const request = adapter.request('r1', {
      method: 'GET',
      path: '/api/git/thread-1/log',
      headers: {},
      signal: controller.signal,
      deadlineAt: Date.now() + 1_000,
    });

    await Bun.sleep(1);
    controller.abort();
    await expect(request).rejects.toMatchObject({ code: FailureCode.CANCELLED });
    const attemptsAtCancellation = attempts;
    await Bun.sleep(20);
    expect(attempts).toBe(attemptsAtCancellation);
  });

  test('maps capacity-wait deadline exhaustion to a runner timeout', async () => {
    const adapter = adapterWith(() => {
      throw new TunnelDispatchError(
        'active tunnel limit exceeded',
        FailureCode.RESOURCE_EXHAUSTED,
        true,
      );
    });

    await expect(
      adapter.request('r1', {
        method: 'GET',
        path: '/api/git/thread-1/log',
        headers: {},
        deadlineAt: Date.now() + 15,
      }),
    ).rejects.toBeInstanceOf(RunnerRequestTimeoutError);
  });
});
