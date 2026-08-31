import { describe, expect, test } from 'bun:test';

import type { EventPayload } from '@gpuix/react';

import { createButtonStyle } from '../button';
import { eventValue } from '../input';
import { darkTheme } from '../theme';

describe('gpuix-ui primitives', () => {
  test('resolves explicit button variants, focus, and disabled state', () => {
    const style = createButtonStyle({
      theme: darkTheme,
      variant: 'danger',
      size: 'small',
      disabled: true,
      focused: true,
    });

    expect(style.backgroundColor).toBe(darkTheme.colors.dangerSurface);
    expect(style.borderColor).toBe(darkTheme.colors.borderStrong);
    expect(style.cursor).toBe('not-allowed');
    expect(style.opacity).toBe(0.55);
    expect(style.paddingTop).toBe(5);
  });

  test('normalizes native input events to string values', () => {
    expect(eventValue({ value: 'Ada' } as EventPayload)).toBe('Ada');
    expect(eventValue({} as EventPayload)).toBe('');
  });
});
