import { FailureCode } from '@funny/shared/runner-v2/common';
import { describe, expect, test, vi } from 'vitest';

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

    expect(handle).toHaveBeenCalledOnce();
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
    await vi.waitFor(() => expect(handle).toHaveBeenCalledOnce());

    adapter.receive({ tunnelId: 't1', cancel: { reason: 'deadline exceeded' } });

    expect(observedSignal?.aborted).toBe(true);
    expect(observedSignal?.reason).toBe('deadline exceeded');
  });
});
