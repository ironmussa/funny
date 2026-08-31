import { describe, expect, test } from 'bun:test';

import { GPUIX_BENCHMARK_CAPABILITIES } from '../capabilities';

describe('GPUIX measurement readiness', () => {
  test('does not claim raw frame or presentation telemetry', () => {
    expect(GPUIX_BENCHMARK_CAPABILITIES.capabilities.frameTiming.status).toBe('unsupported');
    expect(GPUIX_BENCHMARK_CAPABILITIES.capabilities.presentationAcknowledgement.status).toBe(
      'unsupported',
    );
  });

  test('records independently measurable capabilities', () => {
    expect(GPUIX_BENCHMARK_CAPABILITIES.renderer).toBe('gpuix@0.5.1');
    expect(GPUIX_BENCHMARK_CAPABILITIES.capabilities.screenshot.status).toBe('supported');
    expect(GPUIX_BENCHMARK_CAPABILITIES.capabilities.processSampling.status).toBe('supported');
  });
});
