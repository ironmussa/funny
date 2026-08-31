import { describe, expect, test } from 'bun:test';

import { evaluateBenchmarkVerdict } from '../verdict';
import { createTestResult } from './benchmark-result-fixture';

describe('evidence-bounded benchmark verdict', () => {
  test('returns go when all default thresholds pass', () => {
    const web = createTestResult({ rss: 100, inputP95: 10 });
    const gpuix = createTestResult({
      family: 'react-gpuix-gpui',
      rss: 70,
      inputP95: 7,
      switchMedian: 10.5,
    });
    expect(evaluateBenchmarkVerdict(web, gpuix).overall).toBe('go');
  });

  test('returns no-go when a hard frame threshold fails', () => {
    const web = createTestResult();
    const gpuix = createTestResult({
      family: 'react-gpuix-gpui',
      rss: 70,
      scrollP95: 20,
    });
    const verdict = evaluateBenchmarkVerdict(web, gpuix);
    expect(verdict.scenarios.scroll.verdict).toBe('no-go');
    expect(verdict.overall).toBe('no-go');
  });

  test('returns inconclusive when required evidence is unavailable', () => {
    const web = createTestResult({ workloads: [] });
    const gpuix = createTestResult({ family: 'react-gpuix-gpui', workloads: [] });
    const verdict = evaluateBenchmarkVerdict(web, gpuix);
    expect(verdict.scenarios.scroll.verdict).toBe('inconclusive');
    expect(verdict.overall).toBe('inconclusive');
  });

  test('returns inconclusive when improvement is within noise tolerance', () => {
    const web = createTestResult({ rss: 100, inputP95: 10 });
    const gpuix = createTestResult({ family: 'react-gpuix-gpui', rss: 80, inputP95: 8 });
    const verdict = evaluateBenchmarkVerdict(web, gpuix);
    expect(verdict.scenarios.improvement.verdict).toBe('inconclusive');
    expect(verdict.overall).toBe('inconclusive');
  });
});
