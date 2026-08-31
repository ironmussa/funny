import { describe, expect, test } from 'bun:test';

import { BENCHMARK_WORKLOAD_NAMES, BENCHMARK_WORKLOADS } from '../workloads';

describe('renderer-neutral workloads', () => {
  test('defines every workload exactly once', () => {
    expect(Object.keys(BENCHMARK_WORKLOADS)).toEqual(BENCHMARK_WORKLOAD_NAMES);
  });

  test('keeps controlled scenario constants stable', () => {
    expect(BENCHMARK_WORKLOADS.idle.durationMs).toBe(60_000);
    expect(BENCHMARK_WORKLOADS.scroll.steps).toBe(41);
    expect(BENCHMARK_WORKLOADS['repeated-navigation'].switches).toBe(100);
  });
});
