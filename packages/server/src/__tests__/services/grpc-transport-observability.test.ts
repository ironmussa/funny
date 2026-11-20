import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';

import { log } from '../../lib/logger.js';
import { telemetry } from '../../lib/telemetry.js';
import { observeRunnerGrpc } from '../../services/grpc/transport-observability.js';

afterEach(() => {
  mock.restore();
});

describe('runner gRPC transport observability', () => {
  test('emits protocol and epoch health signals without arbitrary secret or payload fields', () => {
    const info = spyOn(log, 'info').mockImplementation(() => log);
    const addMetric = spyOn(telemetry, 'addMetric').mockImplementation(() => undefined);
    const addHistogram = spyOn(telemetry, 'addHistogram').mockImplementation(() => undefined);

    // Fields outside the observation type, which a caller could still pass.
    const unlisted = { credential: 'must-not-appear', payload: { private: true } };
    observeRunnerGrpc({
      ...unlisted,
      event: 'operation-completed',
      streamClass: 'operations',
      status: 'ok',
      runnerId: 'runner-1',
      correlationId: 'correlation-1',
      protocolVersion: 'runner.v2.0',
      sessionEpoch: 7n,
      queueDepth: 3,
      latencyMs: 12,
    });

    expect(addMetric).toHaveBeenCalledTimes(2);
    expect(addHistogram).toHaveBeenCalledTimes(1);
    expect(addMetric.mock.calls[0]?.[0]).toMatchObject({
      name: 'runner.grpc.transport.events',
      attributes: {
        protocolVersion: 'runner.v2.0',
        streamClass: 'operations',
        event: 'operation-completed',
        status: 'ok',
      },
    });
    // winston's typings name only the one-argument overload; the logger passes (message, meta).
    const call: readonly unknown[] = info.mock.calls[0] ?? [];
    const logged = call[1];
    expect(logged).toMatchObject({
      protocolVersion: 'runner.v2.0',
      sessionEpoch: '7',
      queueDepth: 3,
      latencyMs: 12,
    });
    expect(logged).not.toHaveProperty('credential');
    expect(logged).not.toHaveProperty('payload');
  });

  test('warns and records typed failures, reconnects, receipt lag, and gaps', () => {
    const warn = spyOn(log, 'warn').mockImplementation(() => log);
    const addMetric = spyOn(telemetry, 'addMetric').mockImplementation(() => undefined);
    const addHistogram = spyOn(telemetry, 'addHistogram').mockImplementation(() => undefined);

    observeRunnerGrpc({
      event: 'event-gap',
      streamClass: 'events',
      status: 'DEADLINE_EXCEEDED',
      reconnectReason: 'session-replaced',
      receiptLag: 4,
      gapSize: 2,
    });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(addMetric).toHaveBeenCalledTimes(2);
    expect(addHistogram).toHaveBeenCalledTimes(1);
    // winston's typings name only the one-argument overload; the logger passes (message, meta).
    const call: readonly unknown[] = warn.mock.calls[0] ?? [];
    const logged = call[1];
    expect(logged).toMatchObject({
      status: 'DEADLINE_EXCEEDED',
      reconnectReason: 'session-replaced',
      receiptLag: 4,
      gapSize: 2,
    });
  });
});
