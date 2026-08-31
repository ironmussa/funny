import { describe, expect, test } from 'bun:test';

import {
  isPrimaryDockDrag,
  moveDock,
  normalizeDockLayout,
  resizeDockPair,
} from '../dock-layout-model';

const panels = [
  { id: 'navigation', defaultSize: 298, minSize: 220, maxSize: 460 },
  { id: 'conversation', minSize: 320 },
];

describe('dock layout model', () => {
  test('continues a primary drag when GPUIX omits the optional pressed button', () => {
    expect(isPrimaryDockDrag(undefined)).toBe(true);
    expect(isPrimaryDockDrag(0)).toBe(true);
    expect(isPrimaryDockDrag(1)).toBe(false);
    expect(isPrimaryDockDrag(2)).toBe(false);
  });

  test('normalizes persisted order and sizes against the available panels', () => {
    expect(
      normalizeDockLayout(panels, {
        order: ['missing', 'conversation', 'conversation'],
        sizes: { navigation: 900, missing: 100 },
      }),
    ).toEqual({
      order: ['conversation', 'navigation'],
      sizes: { navigation: 460 },
    });
  });

  test('moves a dock before or after another dock without losing entries', () => {
    expect(moveDock(['a', 'b', 'c'], 'a', 'c', 'after')).toEqual(['b', 'c', 'a']);
    expect(moveDock(['a', 'b', 'c'], 'c', 'a', 'before')).toEqual(['c', 'a', 'b']);
  });

  test('resizes a fixed dock next to a fluid dock and respects both minimums', () => {
    expect(
      resizeDockPair({
        leading: panels[0]!,
        trailing: panels[1]!,
        leadingSize: 298,
        trailingSize: 702,
        leadingIsFixed: true,
        trailingIsFixed: false,
        delta: 500,
      }),
    ).toEqual({ navigation: 460 });
  });

  test('preserves the pair size when both adjacent docks are fixed', () => {
    expect(
      resizeDockPair({
        leading: { id: 'a', minSize: 100 },
        trailing: { id: 'b', minSize: 150 },
        leadingSize: 300,
        trailingSize: 300,
        leadingIsFixed: true,
        trailingIsFixed: true,
        delta: 100,
      }),
    ).toEqual({ a: 400, b: 200 });
  });
});
