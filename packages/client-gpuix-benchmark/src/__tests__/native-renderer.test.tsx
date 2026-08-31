import { describe, expect, test } from 'bun:test';

import { createTestRoot, hasNativeTestRenderer } from '@gpuix/react/testing';
import React, { createRef } from 'react';

import {
  BENCHMARK_RETAINED_WINDOW_SIZE,
  GpuixBenchmarkApp,
  type GpuixBenchmarkController,
} from '../app';

describe('GPUIX native benchmark renderer', () => {
  const nativeTest = hasNativeTestRenderer ? test : test.skip;

  nativeTest('renders the fixture through native virtual-list primitives', () => {
    const root = createTestRoot();
    const controller = createRef<GpuixBenchmarkController>();
    root.render(<GpuixBenchmarkApp ref={controller} />);
    const list = root.renderer.findByType('virtual-list')[0];
    expect(list?.children).toHaveLength(BENCHMARK_RETAINED_WINDOW_SIZE);
    expect(root.renderer.findByType('markdown').length).toBeGreaterThan(0);
    expect(root.renderer.findByType('markdown').length).toBeLessThanOrEqual(
      BENCHMARK_RETAINED_WINDOW_SIZE,
    );
    expect(root.renderer.getPaintedText().length).toBeGreaterThan(0);
    expect(controller.current?.snapshot().listId).not.toBeNull();
  });
});
