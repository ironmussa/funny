import { describe, expect, test } from 'bun:test';

import { isErrorDiagnostic } from '../types/workflows.js';

describe('isErrorDiagnostic', () => {
  test('a diagnostic without severity is an error', () => {
    expect(isErrorDiagnostic({ path: 'name', message: 'missing' })).toBe(true);
  });

  test('an explicit error is an error', () => {
    expect(isErrorDiagnostic({ path: 'name', message: 'x', severity: 'error' })).toBe(true);
  });

  test('a warning is not an error', () => {
    expect(isErrorDiagnostic({ path: 'name', message: 'x', severity: 'warning' })).toBe(false);
  });
});
