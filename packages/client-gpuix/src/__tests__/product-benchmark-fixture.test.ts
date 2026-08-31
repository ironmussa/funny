import { describe, expect, test } from 'bun:test';

import {
  PRODUCT_BENCHMARK_FILE_COUNT,
  makeProductBenchmarkFileTree,
  productBenchmarkStreamingContent,
} from '../benchmark/product-fixture';
import { countProductRows } from '../benchmark/product-observation';

describe('GPUIX product benchmark fixture', () => {
  test('provides a deterministic populated nested project', () => {
    const first = makeProductBenchmarkFileTree();
    const second = makeProductBenchmarkFileTree();

    expect(first).toEqual(second);
    expect(first).toHaveLength(PRODUCT_BENCHMARK_FILE_COUNT);
    expect(new Set(first).size).toBe(PRODUCT_BENCHMARK_FILE_COUNT);
    expect(first[0]).toBe('packages/area-00/src/feature-0/file-0000.tsx');
    expect(first.at(-1)).toBe('packages/area-11/src/feature-9/file-1199.tsx');
  });

  test('grows content within the visible message preview on every revision', () => {
    const first = productBenchmarkStreamingContent(1);
    const twentieth = productBenchmarkStreamingContent(20);

    expect(twentieth.startsWith(first)).toBe(true);
    expect(twentieth.length).toBeGreaterThan(first.length);
    expect(twentieth.length).toBeLessThanOrEqual(400);
  });

  test('reports transcript and file-tree rows independently', () => {
    const counts = countProductRows(
      {
        children: [
          { testId: 'message-a', bounds: { y: 20, height: 30 } },
          { testId: 'message-b', bounds: { y: 920, height: 30 } },
          { testId: 'file-tree-folder-src', bounds: { y: 40, height: 24 } },
          { testId: 'file-tree-file-src/a.ts', bounds: { y: 70, height: 24 } },
          { testId: 'file-tree-file-src/b.ts' },
        ],
      },
      900,
    );

    expect(counts).toEqual({
      transcript: { retained: 2, visible: 1 },
      fileTree: { retained: 3, visible: 2 },
    });
  });
});
