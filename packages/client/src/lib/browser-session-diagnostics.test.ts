import { afterEach, describe, expect, it } from 'vitest';

import {
  clearBrowserSessionDiagnostics,
  getBrowserSessionDiagnostics,
  recordBrowserSessionDecodeCompleted,
  recordBrowserSessionDecodeFailed,
  recordBrowserSessionDecodeStarted,
  recordBrowserSessionFrame,
  resetBrowserSessionDiagnosticsForTests,
} from './browser-session-diagnostics';
import {
  clearLatestFrame,
  getLatestFrame,
  ingestBrowserSessionFrame,
} from './browser-session-frames';

describe('browser session diagnostics', () => {
  afterEach(() => {
    resetBrowserSessionDiagnosticsForTests();
  });

  it('records cumulative frame and decode lifecycle counters', () => {
    recordBrowserSessionFrame('session-a', 120, 1_000);
    recordBrowserSessionDecodeStarted('session-a', false);
    recordBrowserSessionDecodeStarted('session-a', true);
    recordBrowserSessionDecodeCompleted('session-a');
    recordBrowserSessionDecodeFailed('session-a');

    const snapshot = getBrowserSessionDiagnostics();
    expect(snapshot.totals).toMatchObject({
      framesReceived: 1,
      payloadBase64Chars: 120,
      latestPayloadBase64Chars: 120,
      decodesStarted: 2,
      decodesCompleted: 1,
      decodeFailures: 1,
      decodesSuperseded: 1,
      lastFrameAt: 1_000,
    });
    expect(snapshot.trackedSessions).toEqual([
      expect.objectContaining({
        sessionId: 'session-a',
        framesReceived: 1,
        decodesSuperseded: 1,
      }),
    ]);
  });

  it('removes per-session state without clearing cumulative totals', () => {
    recordBrowserSessionFrame('session-a', 42, 1_000);
    clearBrowserSessionDiagnostics('session-a');

    const snapshot = getBrowserSessionDiagnostics();
    expect(snapshot.trackedSessions).toEqual([]);
    expect(snapshot.totals.framesReceived).toBe(1);
    expect(snapshot.totals.payloadBase64Chars).toBe(42);
  });

  it('bounds tracked session details while preserving cumulative totals', () => {
    for (let index = 0; index < 20; index++) {
      recordBrowserSessionFrame(`session-${index}`, index + 1, index);
    }

    const snapshot = getBrowserSessionDiagnostics();
    expect(snapshot.trackedSessions).toHaveLength(16);
    expect(snapshot.trackedSessions[0]?.sessionId).toBe('session-4');
    expect(snapshot.totals.framesReceived).toBe(20);
  });

  it('wires frame cache ingestion and cleanup to diagnostics', () => {
    ingestBrowserSessionFrame('session-a', 'base64-payload');
    expect(getLatestFrame('session-a')).toBe('base64-payload');
    expect(getBrowserSessionDiagnostics().totals.framesReceived).toBe(1);

    clearLatestFrame('session-a');
    expect(getLatestFrame('session-a')).toBeNull();
    expect(getBrowserSessionDiagnostics().trackedSessions).toEqual([]);
  });
});
