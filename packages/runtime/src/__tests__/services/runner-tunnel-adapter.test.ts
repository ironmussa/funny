import { describe, expect, test, vi } from 'bun:test';

import { FailureCode } from '@funny/shared/runner-v2/common';
import { waitFor } from '@funny/test-kit';

import { RunnerTunnelAdapter } from '../../services/runner-tunnel-adapter.js';

describe('RunnerTunnelAdapter', () => {
  test('assembles request frames and chunks the local response', async () => {
    const send = vi.fn((_name: 'tunnel', _message: Record<string, any>) => true);
    const handle = vi.fn(async (request: Request) => {
      expect(request.method).toBe('POST');
      expect(await request.text()).toBe('hello');
      return new Response('world', { status: 201, headers: { 'x-result': 'ok' } });
    });
    const adapter = new RunnerTunnelAdapter({ send }, handle);
    adapter.setMaxFrameBytes(3);

    adapter.receive({
      tunnelId: 't1',
      requestStart: { method: 'POST', path: '/echo', headers: [] },
    });
    adapter.receive({
      tunnelId: 't1',
      data: { sequence: '1', data: Buffer.from('hel').toString('base64') },
    });
    adapter.receive({
      tunnelId: 't1',
      data: { sequence: '2', data: Buffer.from('lo').toString('base64') },
    });
    adapter.receive({ tunnelId: 't1', end: { finalSequence: '2' } });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(handle).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(
      'tunnel',
      expect.objectContaining({
        tunnelId: 't1',
        responseStart: expect.objectContaining({ statusCode: 201 }),
      }),
    );
    const dataFrames = send.mock.calls.filter(([, message]) => message.data);
    expect(dataFrames).toHaveLength(2);
  });

  test('rejects invalid input sequencing before dispatch', () => {
    const send = vi.fn((_name: 'tunnel', _message: Record<string, any>) => true);
    const handle = vi.fn(async () => new Response());
    const adapter = new RunnerTunnelAdapter({ send }, handle);
    adapter.receive({ tunnelId: 't1', requestStart: { method: 'POST', path: '/', headers: [] } });
    adapter.receive({ tunnelId: 't1', data: { sequence: '2', data: '' } });

    expect(handle).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith('tunnel', {
      tunnelId: 't1',
      failure: {
        code: FailureCode.INVALID_ARGUMENT,
        message: 'invalid tunnel request data',
        retryable: false,
      },
    });
  });

  test('cancels a local request after all request frames were received', async () => {
    const send = vi.fn((_name: 'tunnel', _message: Record<string, any>) => true);
    let observedSignal: AbortSignal | undefined;
    const handle = vi.fn(async (_request: Request, signal: AbortSignal) => {
      observedSignal = signal;
      return new Promise<Response>(() => undefined);
    });
    const adapter = new RunnerTunnelAdapter({ send }, handle);
    adapter.receive({ tunnelId: 't1', requestStart: { method: 'GET', path: '/', headers: [] } });
    adapter.receive({ tunnelId: 't1', end: {} });
    await waitFor(() => expect(handle).toHaveBeenCalledTimes(1));

    adapter.receive({ tunnelId: 't1', cancel: { reason: 'deadline exceeded' } });

    expect(observedSignal?.aborted).toBe(true);
    expect(observedSignal?.reason).toBe('deadline exceeded');
  });

  test('aborts in-flight requests on disconnect and sends nothing on the next session', async () => {
    const send = vi.fn((_name: 'tunnel', _message: Record<string, any>) => true);
    let observedSignal: AbortSignal | undefined;
    let release!: (response: Response) => void;
    const handle = vi.fn(async (_request: Request, signal: AbortSignal) => {
      observedSignal = signal;
      return new Promise<Response>((resolve) => (release = resolve));
    });
    const adapter = new RunnerTunnelAdapter({ send }, handle);
    adapter.receive({ tunnelId: 't1', requestStart: { method: 'GET', path: '/', headers: [] } });
    adapter.receive({ tunnelId: 't1', end: {} });
    await waitFor(() => expect(handle).toHaveBeenCalledTimes(1));

    adapter.shutdown('gRPC session disconnected');
    expect(observedSignal?.aborted).toBe(true);

    // The handler ignores the signal and answers anyway on the new session.
    release(new Response('late'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(send).not.toHaveBeenCalled();
  });

  test('refuses a request body larger than the limit', () => {
    const send = vi.fn((_name: 'tunnel', _message: Record<string, any>) => true);
    const handle = vi.fn(async () => new Response());
    const adapter = new RunnerTunnelAdapter({ send }, handle);
    adapter.setMaxRequestBodyBytes(4);
    adapter.receive({ tunnelId: 't1', requestStart: { method: 'POST', path: '/', headers: [] } });
    adapter.receive({
      tunnelId: 't1',
      data: { sequence: '1', data: Buffer.from('abc').toString('base64') },
    });
    adapter.receive({
      tunnelId: 't1',
      data: { sequence: '2', data: Buffer.from('de').toString('base64') },
    });
    adapter.receive({ tunnelId: 't1', end: { finalSequence: '2' } });

    expect(handle).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('tunnel', {
      tunnelId: 't1',
      failure: {
        code: FailureCode.RESOURCE_EXHAUSTED,
        message: 'tunnel request body exceeds the configured limit',
        retryable: false,
      },
    });
  });

  test('waits for the stream to drain before sending the next frame', async () => {
    let writable = false;
    const send = vi.fn((_name: 'tunnel', _message: Record<string, any>) => writable);
    let drain!: (drained: boolean) => void;
    const waitForDrain = vi.fn(() => new Promise<boolean>((resolve) => (drain = resolve)));
    const handle = vi.fn(async () => new Response('abcdef'));
    const adapter = new RunnerTunnelAdapter({ send, waitForDrain }, handle);
    adapter.setMaxFrameBytes(2);
    adapter.receive({ tunnelId: 't1', requestStart: { method: 'GET', path: '/', headers: [] } });
    adapter.receive({ tunnelId: 't1', end: {} });

    await waitFor(() => expect(waitForDrain).toHaveBeenCalledTimes(1));
    // The response head filled the buffer: no data frame until it drains.
    expect(send).toHaveBeenCalledTimes(1);

    writable = true;
    drain(true);
    await waitFor(() =>
      expect(send).toHaveBeenLastCalledWith('tunnel', {
        tunnelId: 't1',
        end: { finalSequence: '3' },
      }),
    );
    expect(send.mock.calls.filter(([, message]) => message.data)).toHaveLength(3);
  });

  test('stops the response when the session ends while waiting to drain', async () => {
    const send = vi.fn((_name: 'tunnel', _message: Record<string, any>) => false);
    const waitForDrain = vi.fn(async () => false);
    let observedSignal: AbortSignal | undefined;
    const handle = vi.fn(async (_request: Request, signal: AbortSignal) => {
      observedSignal = signal;
      return new Response('abcdef');
    });
    const adapter = new RunnerTunnelAdapter({ send, waitForDrain }, handle);
    adapter.receive({ tunnelId: 't1', requestStart: { method: 'GET', path: '/', headers: [] } });
    adapter.receive({ tunnelId: 't1', end: {} });

    await waitFor(() => expect(observedSignal?.aborted).toBe(true));
    expect(send).toHaveBeenCalledTimes(1);
  });
});
