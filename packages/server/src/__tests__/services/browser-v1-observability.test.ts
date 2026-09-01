import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';

import { log } from '../../lib/logger.js';
import { telemetry } from '../../lib/telemetry.js';
import { observeBrowserV1 } from '../../services/socketio/browser-v1-observability.js';

afterEach(() => mock.restore());

describe('browser.v1 transport observability', () => {
  test('records allowlisted transport health without accepting payload or credentials', () => {
    const warn = spyOn(log, 'warn').mockImplementation(() => log);
    const addMetric = spyOn(telemetry, 'addMetric').mockImplementation(() => undefined);
    const addHistogram = spyOn(telemetry, 'addHistogram').mockImplementation(() => undefined);

    observeBrowserV1({
      event: 'queue',
      status: 'rejected',
      trafficClass: 'terminal',
      representation: 'browser.v1',
      reason: 'exhausted',
      payloadBytes: 2048,
      latencyMs: 9,
      queueDepth: 256,
      credential: 'secret',
      payload: { private: true },
    } as Parameters<typeof observeBrowserV1>[0]);

    expect(addMetric).toHaveBeenCalledTimes(2);
    expect(addHistogram).toHaveBeenCalledTimes(2);
    const logged = (warn.mock.calls as unknown as Array<[string, Record<string, unknown>]>)[0]?.[1];
    expect(logged).toMatchObject({
      protocolVersion: 'browser.v1',
      trafficClass: 'terminal',
      reason: 'exhausted',
      payloadBytes: 2048,
      queueDepth: 256,
    });
    expect(logged).not.toHaveProperty('credential');
    expect(logged).not.toHaveProperty('payload');
  });
});
