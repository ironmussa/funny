import { describe, expect, test } from 'bun:test';

import type { DetailedProcessTreeSample } from '../../renderer-benchmark/process-sampler';
import {
  analyzeClientMemorySoak,
  renderClientMemoryReport,
  type ClientMemorySample,
  type SoakPhaseName,
} from '../analyze';

const MIB = 1024 * 1024;

function sample(
  minute: number,
  rssMiB: number,
  heapMiB: number,
  phase: SoakPhaseName = 'idle',
): ClientMemorySample {
  const process: DetailedProcessTreeSample = {
    timestampMs: minute * 60_000,
    processCount: 4,
    rssBytes: rssMiB * MIB,
    chromiumRssBytes: rssMiB * MIB,
    cpuPercent: 0,
    rssBytesByRole: {
      browser: 100 * MIB,
      renderer: (rssMiB - 100) * MIB,
      gpu: 0,
      utility: 0,
      zygote: 0,
      harness: 0,
    },
    processCountByRole: { browser: 1, renderer: 1, gpu: 0, utility: 0, zygote: 0, harness: 2 },
  };
  return {
    timestampMs: minute * 60_000,
    phase,
    process,
    heap: { usedBytes: heapMiB * MIB, totalBytes: (heapMiB + 20) * MIB },
    dom: { documents: 1, nodes: 1000, listeners: 50 },
    profiler: { sessionId: 'run-1', workersLive: 1 },
  };
}

describe('client memory soak analysis', () => {
  test('detects likely native retention when RSS rises and heap stays flat', () => {
    const samples = Array.from({ length: 7 }, (_, index) =>
      sample(index, 500 + index * 30, 200 + index),
    );
    const analysis = analyzeClientMemorySoak(samples);

    expect(analysis.verdict).toBe('native-retention-likely');
    expect(analysis.phases[0]?.rssGrowthBytes).toBe(180 * MIB);
  });

  test('reports stable runs and renders a portable report', () => {
    const samples = Array.from({ length: 7 }, (_, index) => sample(index, 500 + index, 200));
    const analysis = analyzeClientMemorySoak(samples);

    expect(analysis.verdict).toBe('stable');
    expect(renderClientMemoryReport(analysis)).toContain('**Verdict:** stable');
  });

  test('keeps short smoke runs inconclusive', () => {
    const analysis = analyzeClientMemorySoak([sample(0, 500, 200), sample(1, 700, 200)]);
    expect(analysis.verdict).toBe('inconclusive');
  });
});
