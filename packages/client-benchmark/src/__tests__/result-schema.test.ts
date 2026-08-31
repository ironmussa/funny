import { describe, expect, test } from 'bun:test';

import {
  BENCHMARK_CAPABILITY_SCHEMA_VERSION,
  supportedCapability,
  unsupportedCapability,
} from '../capabilities';
import { BENCHMARK_RESULT_SCHEMA_VERSION, parseBenchmarkResult } from '../result-schema';

function validResult(): unknown {
  return {
    schemaVersion: BENCHMARK_RESULT_SCHEMA_VERSION,
    runId: 'run-1',
    status: 'complete',
    renderer: {
      family: 'react-gpuix-gpui',
      variant: 'virtual',
      version: '0.4.0',
      runtimeVersion: '1.4.0',
    },
    fixture: {
      version: 'long-thread-v2',
      checksums: { a: 'abc', b: 'def' },
      featureInventory: { markdown: 250, code: 1, table: 1, toolCall: 1, diff: 1 },
      messageCount: 500,
      toolCallCount: 1,
      retainedItemCount: 500,
      visibleItemCount: 12,
    },
    environment: {
      gitRevision: 'abcdef0',
      os: 'linux',
      architecture: 'x64',
      cpu: 'test cpu',
      gpu: null,
      totalMemoryBytes: 1024,
      powerState: null,
      viewport: { width: 1440, height: 900 },
      theme: 'benchmark-dark-v1',
      refreshTargetHz: 60,
      buildMode: 'release',
      startedAt: '2026-08-23T00:00:00.000Z',
      finishedAt: '2026-08-23T00:01:00.000Z',
    },
    configuration: { warmupCount: 1, measuredCount: 3, order: 'ABBA' },
    capabilities: {
      schemaVersion: BENCHMARK_CAPABILITY_SCHEMA_VERSION,
      renderer: 'gpuix@0.4.0',
      capabilities: {
        frameTiming: unsupportedCapability('not exported'),
        presentationAcknowledgement: unsupportedCapability('not exported'),
        gpuMemory: unsupportedCapability('not exported'),
        screenshot: supportedCapability('captureScreenshot'),
        processSampling: supportedCapability('process sampler'),
      },
    },
    workloads: [],
    validity: { valid: true, reasons: [] },
  };
}

describe('benchmark result schema', () => {
  test('accepts complete provenance and capabilities', () => {
    expect(parseBenchmarkResult(validResult()).runId).toBe('run-1');
  });

  test('rejects incompatible schema versions', () => {
    expect(() =>
      parseBenchmarkResult({
        ...(validResult() as Record<string, unknown>),
        schemaVersion: BENCHMARK_RESULT_SCHEMA_VERSION + 1,
      }),
    ).toThrow('Invalid benchmark result');
  });

  test('rejects missing required provenance', () => {
    const value = validResult() as { environment: Record<string, unknown> };
    delete value.environment.gitRevision;
    expect(() => parseBenchmarkResult(value)).toThrow('gitRevision');
  });
});
