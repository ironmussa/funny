import { describe, expect, test } from 'bun:test';

import { createInMemoryPlatform } from '@funny/client-core/testing';

import {
  NATIVE_DOCK_LAYOUT_STORAGE_KEY,
  NativeDockLayoutPreference,
  resolveNativeDockLayout,
} from '../dock-layout-preference';

describe('native dock layout preference', () => {
  test('falls back safely for malformed persisted layouts', () => {
    expect(resolveNativeDockLayout('not-json')).toEqual({
      order: ['navigation', 'conversation', 'files'],
      sizes: { navigation: 300, files: 300 },
    });
    expect(resolveNativeDockLayout('{"order":["conversation","unknown"]}').order).toEqual([
      'conversation',
      'navigation',
      'files',
    ]);
  });

  test('migrates legacy layouts by placing files on the right', () => {
    expect(
      resolveNativeDockLayout(
        JSON.stringify({
          order: ['navigation', 'files', 'conversation'],
          sizes: { navigation: 320 },
        }),
      ),
    ).toEqual({
      order: ['navigation', 'conversation', 'files'],
      sizes: { navigation: 320, files: 300 },
    });
  });

  test('preserves a user order saved with the current layout version', () => {
    expect(
      resolveNativeDockLayout(
        JSON.stringify({
          version: 2,
          order: ['files', 'conversation', 'navigation'],
          sizes: {},
        }),
      ).order,
    ).toEqual(['files', 'conversation', 'navigation']);
  });

  test('persists normalized order and bounded sizes after a gesture commits', () => {
    const host = createInMemoryPlatform();
    const preference = new NativeDockLayoutPreference(host.platform.storage);
    preference.save({
      order: ['conversation', 'files', 'navigation'],
      sizes: { navigation: 900, files: 220 },
    });

    expect(preference.current()).toEqual({
      order: ['conversation', 'files', 'navigation'],
      sizes: { navigation: 600, files: 240 },
    });
    expect(JSON.parse(host.controls.storageSnapshot()[NATIVE_DOCK_LAYOUT_STORAGE_KEY]!)).toEqual({
      version: 2,
      ...preference.current(),
    });
  });

  test('preserves hidden docks while saving a visible subset', () => {
    const host = createInMemoryPlatform();
    const preference = new NativeDockLayoutPreference(host.platform.storage);
    preference.save({
      order: ['conversation', 'navigation'],
      sizes: { navigation: 360 },
    });
    expect(preference.current()).toEqual({
      order: ['conversation', 'navigation', 'files'],
      sizes: { navigation: 360, files: 300 },
    });
  });
});
