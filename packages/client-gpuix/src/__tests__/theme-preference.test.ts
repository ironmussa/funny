import { describe, expect, test } from 'bun:test';

import { createInMemoryPlatform } from '@funny/client-core/testing';

import {
  DEFAULT_NATIVE_THEME,
  NATIVE_THEME_STORAGE_KEY,
  NativeThemePreferenceService,
  resolveNativeTheme,
} from '../theme-preference';

describe('native theme preference', () => {
  test('defaults invalid and parity-only values to React one-dark', () => {
    expect(resolveNativeTheme(null)).toBe(DEFAULT_NATIVE_THEME);
    expect(resolveNativeTheme('unknown')).toBe('one-dark');
    expect(resolveNativeTheme('reference-dark')).toBe('one-dark');
    expect(resolveNativeTheme('one-dark')).toBe('one-dark');
  });

  test('persists selection and follows external storage changes', () => {
    const host = createInMemoryPlatform();
    const preference = new NativeThemePreferenceService(host.platform.storage);
    expect(preference.state.getState().name).toBe('one-dark');
    preference.select('one-dark');
    expect(host.controls.storageSnapshot()[NATIVE_THEME_STORAGE_KEY]).toBe('one-dark');
    host.controls.setStorage(NATIVE_THEME_STORAGE_KEY, 'invalid');
    expect(preference.state.getState().name).toBe('one-dark');
    preference.dispose();
  });
});
