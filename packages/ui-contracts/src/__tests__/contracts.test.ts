import { describe, expect, test } from 'bun:test';

import { visualParityFixtures } from '../fixtures';
import { parityInventoryIds } from '../inventory';
import {
  isVisualThemeName,
  oneDark,
  referenceDark,
  VISUAL_THEME_NAMES,
  visualContract,
} from '../tokens';

describe('visual contracts', () => {
  test('exposes stable reference-dark values', () => {
    expect(visualContract()).toBe(referenceDark);
    expect(referenceDark.colors.canvas).toBe('#1b1e23');
    expect(referenceDark.colors.sidebar).toBe('#14171a');
    expect(referenceDark.layout.conversationMaximumWidth).toBe(768);
    expect(referenceDark.layout.composerMaximumWidth).toBe(768);
    expect(referenceDark.layout.compactBreakpoint).toBe(860);
  });

  test('publishes React one-dark as a named theme without changing parity identity', () => {
    expect(VISUAL_THEME_NAMES).toEqual(['reference-dark', 'one-dark']);
    expect(visualContract('one-dark')).toBe(oneDark);
    expect(oneDark.name).toBe('one-dark');
    expect(oneDark.colors).toEqual(referenceDark.colors);
    expect(isVisualThemeName('one-dark')).toBe(true);
    expect(isVisualThemeName('unknown')).toBe(false);
  });

  test('keeps fixture and inventory identifiers unique', () => {
    const fixtureIds = visualParityFixtures.map((fixture) => fixture.id);
    const inventoryIds = parityInventoryIds();
    expect(new Set(fixtureIds).size).toBe(fixtureIds.length);
    expect(new Set(inventoryIds).size).toBe(inventoryIds.length);
    expect(inventoryIds).toContain('composer:read-only');
    expect(inventoryIds).toContain('activity:permission-resolved');
  });
});
