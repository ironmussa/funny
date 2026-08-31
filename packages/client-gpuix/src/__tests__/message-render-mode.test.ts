import { describe, expect, test } from 'bun:test';

import { assistantMessageUsesRichPresentation } from '../message-render-mode';

describe('native assistant message render mode', () => {
  test('forces streaming delivery onto the lightweight path', () => {
    expect(assistantMessageUsesRichPresentation(true, 'streaming')).toBe(false);
    expect(assistantMessageUsesRichPresentation(false, 'streaming')).toBe(false);
  });

  test('restores the selected presentation after durable delivery', () => {
    expect(assistantMessageUsesRichPresentation(true, 'confirmed')).toBe(true);
    expect(assistantMessageUsesRichPresentation(true, undefined)).toBe(true);
    expect(assistantMessageUsesRichPresentation(false, 'confirmed')).toBe(false);
  });
});
