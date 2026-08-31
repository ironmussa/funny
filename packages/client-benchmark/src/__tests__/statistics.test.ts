import { describe, expect, test } from 'bun:test';

import {
  bootstrapMedianConfidence,
  median,
  medianAbsoluteDeviation,
  percentile,
  summarizeMetricSamples,
} from '../statistics';

describe('benchmark statistics', () => {
  test('calculates medians, nearest-rank percentiles, and dispersion', () => {
    expect(median([])).toBeNull();
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(percentile([1, 2, 3, 4, 5], 0.95)).toBe(5);
    expect(medianAbsoluteDeviation([1, 2, 3, 100])).toBe(1);
    expect(() => percentile([1], 2)).toThrow('Percentile must be between');
  });

  test('produces deterministic bootstrap confidence intervals', () => {
    const first = bootstrapMedianConfidence([1, 2, 3, 4, 5], { seed: 42, iterations: 200 });
    const second = bootstrapMedianConfidence([1, 2, 3, 4, 5], { seed: 42, iterations: 200 });
    expect(first).toEqual(second);
    expect(first?.lower).toBeLessThanOrEqual(3);
    expect(first?.upper).toBeGreaterThanOrEqual(3);
  });

  test('summarizes valid samples and accounts for invalid and missed-budget samples', () => {
    const summary = summarizeMetricSamples(
      [8, 10, 20, 30].map((value, index) => ({
        metric: 'frame-time',
        value,
        unit: 'ms' as const,
        timestampMs: index,
        valid: index !== 3,
        reason: index === 3 ? 'interrupted' : undefined,
      })),
      { bootstrapSeed: 1, bootstrapIterations: 100 },
    );
    expect(summary.sampleCount).toBe(3);
    expect(summary.invalidCount).toBe(1);
    expect(summary.median).toBe(10);
    expect(summary.over16_67MsRatio).toBeCloseTo(1 / 3);
  });
});
