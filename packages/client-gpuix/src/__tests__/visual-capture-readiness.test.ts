import { describe, expect, test } from 'bun:test';

import {
  failedVisualCaptureEvidence,
  unsupportedVisualCaptureEvidence,
  waitForStableRendererEvidence,
} from '../visual-capture-readiness';

function deterministicClock() {
  let current = 0;
  return {
    now: () => current,
    sleep: async (milliseconds: number) => {
      current += milliseconds;
    },
  };
}

describe('visual capture readiness', () => {
  test('requires the expected marker in consecutive stable observations', async () => {
    const evidence = [
      'loading',
      'tree parity-fixture-reference phase-one',
      'tree parity-fixture-reference ready',
      'tree parity-fixture-reference ready',
    ];
    let index = 0;
    const clock = deterministicClock();

    await expect(
      waitForStableRendererEvidence({
        marker: 'parity-fixture-reference',
        readEvidence: () => evidence[Math.min(index++, evidence.length - 1)]!,
        timeoutMs: 100,
        intervalMs: 10,
        now: clock.now,
        sleep: clock.sleep,
      }),
    ).resolves.toEqual({
      evidence: 'tree parity-fixture-reference ready',
      observations: 4,
    });
  });

  test('fails actionably when readiness remains unavailable', async () => {
    const clock = deterministicClock();

    await expect(
      waitForStableRendererEvidence({
        marker: 'parity-fixture-reference',
        readEvidence: () => 'loading',
        timeoutMs: 20,
        intervalMs: 10,
        now: clock.now,
        sleep: clock.sleep,
      }),
    ).rejects.toThrow('marker=parity-fixture-reference observations=3');
  });

  test('distinguishes unsupported hosts from failed supported captures', () => {
    expect(unsupportedVisualCaptureEvidence('fixture', 'Metal or DirectX required')).toEqual({
      fixtureId: 'fixture',
      screenshot: {
        supported: false,
        reason: 'Metal or DirectX required',
      },
      structuralEvidence: 'available',
    });
    expect(failedVisualCaptureEvidence('fixture', new Error('not stable'))).toEqual({
      fixtureId: 'fixture',
      screenshot: { supported: true, captured: false, error: 'not stable' },
      structuralEvidence: 'not-ready',
    });
  });
});
