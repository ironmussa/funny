import { describe, expect, test } from 'bun:test';

import {
  diagnosticSurfacePosition,
  nativeRenderingModeLabel,
  resolveNativeDiagnosticMode,
} from '../diagnostic-mode';

describe('native diagnostic mode', () => {
  test('is opt-in and overlays rather than resizing product composition', () => {
    expect(resolveNativeDiagnosticMode(undefined)).toBeFalse();
    expect(resolveNativeDiagnosticMode('false')).toBeFalse();
    expect(resolveNativeDiagnosticMode('true')).toBeTrue();
    expect(diagnosticSurfacePosition.position).toBe('absolute');
  });

  test('labels the active rendering mode instead of the next action', () => {
    expect(nativeRenderingModeLabel(true)).toBe('Rendering: Rich');
    expect(nativeRenderingModeLabel(false)).toBe('Rendering: Fast');
  });
});
