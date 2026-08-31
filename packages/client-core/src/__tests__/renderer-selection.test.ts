import { describe, expect, test } from 'bun:test';

import { selectClientRenderer } from '../renderer-selection';

describe('client renderer selection', () => {
  test('keeps the web renderer as the default', () => {
    expect(selectClientRenderer([])).toBe('web');
    expect(selectClientRenderer(['--renderer=web'])).toBe('web');
  });

  test('requires an explicit GPUIX selection', () => {
    expect(selectClientRenderer(['--renderer=gpuix'])).toBe('gpuix');
  });

  test('rejects unknown renderers', () => {
    expect(() => selectClientRenderer(['--renderer=canvas'])).toThrow(
      'Unknown client renderer: canvas',
    );
  });
});
