import { describe, expect, test } from 'bun:test';

import { validateFeatureEquivalence, validatePairedRuns } from '../comparison';
import { createTestResult } from './benchmark-result-fixture';

describe('paired benchmark validation', () => {
  test('accepts controlled and feature-equivalent pairs', () => {
    const web = createTestResult();
    const gpuix = createTestResult({ family: 'react-gpuix-gpui' });
    expect(validatePairedRuns(web, gpuix)).toEqual({ valid: true, reasons: [] });
    expect(validateFeatureEquivalence(web, gpuix)).toEqual({ valid: true, reasons: [] });
  });

  test('reports environment and feature mismatches', () => {
    const web = createTestResult();
    const gpuix = createTestResult({ family: 'react-gpuix-gpui' });
    gpuix.environment.viewport.width = 1280;
    gpuix.fixture.featureInventory.diff = 0;
    expect(validatePairedRuns(web, gpuix).reasons).toContain(
      'viewport mismatch: {"width":1440,"height":900} !== {"width":1280,"height":900}',
    );
    expect(validateFeatureEquivalence(web, gpuix).reasons[0]).toContain(
      'feature inventory mismatch',
    );
  });

  test('requires retained and visible counter evidence without requiring equal values', () => {
    const web = createTestResult();
    const gpuix = createTestResult({ family: 'react-gpuix-gpui' });
    gpuix.fixture.visibleItemCount = 20;
    expect(validateFeatureEquivalence(web, gpuix).valid).toBe(true);
    gpuix.fixture.visibleItemCount = null;
    expect(validateFeatureEquivalence(web, gpuix).reasons).toContain(
      'GPUIX visible count is missing',
    );
  });
});
