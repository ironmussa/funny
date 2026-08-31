import { describe, expect, test } from 'bun:test';

import { createRendererComparison, renderRendererComparisonMarkdown } from '../report';
import { createTestResult } from './benchmark-result-fixture';

describe('renderer comparison report', () => {
  test('separates comparable metrics from renderer-specific diagnostics', () => {
    const web = createTestResult({ rss: 100 });
    const gpuix = createTestResult({ family: 'react-gpuix-gpui', rss: 70 });
    const scroll = gpuix.workloads.find((workload) => workload.name === 'scroll')!;
    scroll.summaries = [];
    scroll.diagnostics = {
      nativeFrameOverlayMode: 'full',
      nativeDrawCurrentMs: 1.25,
      nativeDrawP90Ms: 2.5,
      nativeDrawP99Ms: 4.75,
      nativeDrawMaxMs: 8,
      nativeDrawTotalFrames: 120,
      nativeDrawSampleCount: 100,
    };
    const comparison = createRendererComparison(web, gpuix, '2026-08-23T00:00:00.000Z');
    expect(
      comparison.comparableMetrics.some((metric) => metric.metric === 'process-tree-rss'),
    ).toBe(true);
    expect(comparison.rendererDiagnostics.webOnly).toContain('scroll:frame-time:ms');
    expect(comparison.rendererDiagnostics.gpuixDraw).toEqual([
      {
        workload: 'scroll',
        overlayMode: 'full',
        currentMs: 1.25,
        p90Ms: 2.5,
        p99Ms: 4.75,
        maxMs: 8,
        totalFrames: 120,
        sampleCount: 100,
      },
    ]);
    const markdown = renderRendererComparisonMarkdown(comparison);
    expect(markdown).toContain('### GPUIX native draw overlay');
    expect(markdown).toContain('| scroll | full | 1.25 | 2.50 | 4.75 | 8.00 | 120 | 100 |');
    expect(markdown).toContain('not presented-frame latency or GPU memory');
  });

  test('labels the stack accurately and renders evidence and targets', () => {
    const comparison = createRendererComparison(
      createTestResult(),
      createTestResult({ family: 'react-gpuix-gpui', rss: 70 }),
      '2026-08-23T00:00:00.000Z',
    );
    const markdown = renderRendererComparisonMarkdown(comparison);
    expect(markdown).toContain('React DOM/Chromium versus React/GPUIX/GPUI');
    expect(markdown).toContain('this is not a CPU-versus-GPU test');
    expect(markdown).toContain('## Configured targets');
    expect(markdown).toContain('median [95% CI]');
    expect(markdown).toContain('[8.00 ms, 8.00 ms]');
    expect(markdown).toContain('## Capability gaps');
    expect(markdown).toContain('gpuMemory: test');
  });

  test('never issues no-go when the pair is ineligible for comparison', () => {
    const web = createTestResult();
    const gpuix = createTestResult({ family: 'react-gpuix-gpui', scrollP95: 30 });
    gpuix.fixture.visibleItemCount = null;
    expect(createRendererComparison(web, gpuix).verdict.overall).toBe('inconclusive');
  });

  test('rejects a pair recorded with different controlled themes', () => {
    const web = createTestResult();
    const gpuix = createTestResult({ family: 'react-gpuix-gpui' });
    Object.assign(gpuix.environment, { theme: 'different-theme' });
    const comparison = createRendererComparison(web, gpuix);
    expect(comparison.validity.valid).toBe(false);
    expect(comparison.validity.reasons.join(' ')).toContain('theme mismatch');
  });
});
