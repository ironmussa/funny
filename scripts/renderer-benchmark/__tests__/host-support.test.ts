import { describe, expect, test } from 'bun:test';

import { createUnsupportedGpuixResult, controlledHostSupport } from '../host-support';

describe('renderer benchmark host support', () => {
  test('supports controlled macOS and Linux profiles', () => {
    expect(controlledHostSupport('linux')).toEqual({ supported: true });
    expect(controlledHostSupport('darwin')).toEqual({ supported: true });
  });

  test('returns a schema-valid structured result on unsupported native hosts', () => {
    const support = controlledHostSupport('win32');
    expect(support.supported).toBe(false);
    const result = createUnsupportedGpuixResult({
      platform: 'win32',
      architecture: 'x64',
      cpu: 'test cpu',
      totalMemoryBytes: 1024,
      gitRevision: 'abcdef0',
      reason: support.reason!,
      timestamp: '2026-08-23T00:00:00.000Z',
    });
    expect(result.status).toBe('unsupported');
    expect(result.workloads).toHaveLength(7);
    expect(result.workloads.every((workload) => workload.status === 'unsupported')).toBe(true);
    expect(result.capabilities.capabilities.processSampling.status).toBe('unsupported');
  });
});
