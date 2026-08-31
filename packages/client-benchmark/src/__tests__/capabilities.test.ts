import { describe, expect, test } from 'bun:test';

import {
  BENCHMARK_CAPABILITY_NAMES,
  BENCHMARK_CAPABILITY_SCHEMA_VERSION,
  supportedCapability,
  unsupportedCapability,
} from '../capabilities';

describe('benchmark capabilities', () => {
  test('keeps the renderer-neutral capability inventory stable', () => {
    expect(BENCHMARK_CAPABILITY_SCHEMA_VERSION).toBe(1);
    expect(BENCHMARK_CAPABILITY_NAMES).toEqual([
      'frameTiming',
      'presentationAcknowledgement',
      'gpuMemory',
      'screenshot',
      'processSampling',
    ]);
  });

  test('does not represent unavailable measurements as zero-valued support', () => {
    expect(unsupportedCapability('No public telemetry API')).toEqual({
      status: 'unsupported',
      reason: 'No public telemetry API',
      evidence: [],
    });
    expect(supportedCapability('process-tree sampler')).toEqual({
      status: 'supported',
      source: 'process-tree sampler',
      evidence: [],
    });
  });
});
