import { describe, expect, test } from 'vitest';

import { resolveLeftPaneOpen } from '@/lib/app-layout';

describe('app layout', () => {
  test('keeps the left thread pane hidden while workflow routes are active', () => {
    expect(resolveLeftPaneOpen(true, true)).toBe(false);
  });

  test('respects the stored sidebar state outside forced-hidden views', () => {
    expect(resolveLeftPaneOpen(true, false)).toBe(true);
    expect(resolveLeftPaneOpen(false, false)).toBe(false);
  });
});
