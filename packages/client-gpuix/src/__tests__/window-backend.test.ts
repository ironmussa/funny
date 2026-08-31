import { describe, expect, test } from 'bun:test';

import { configureNativeWindowBackend, resolveNativeLinuxWindowBackend } from '../native-backend';
import { NATIVE_CLIENT_WINDOW_OPTIONS } from '../native-frame-options';

describe('native GPUIX window backend', () => {
  test('normalizes supported values and defaults missing or invalid values to auto', () => {
    expect(resolveNativeLinuxWindowBackend(' X11 ')).toBe('x11');
    expect(resolveNativeLinuxWindowBackend('WAYLAND')).toBe('wayland');
    expect(resolveNativeLinuxWindowBackend('auto')).toBe('auto');
    expect(resolveNativeLinuxWindowBackend(undefined)).toBe('auto');
    expect(resolveNativeLinuxWindowBackend('unsupported')).toBe('auto');
  });

  test('disables Wayland only for Linux x11 mode', () => {
    const environment = { WAYLAND_DISPLAY: 'wayland-0' };

    expect(
      configureNativeWindowBackend({ platform: 'linux', preference: 'x11', environment }),
    ).toBe('x11');
    expect(environment.WAYLAND_DISPLAY).toBe('');
  });

  test.each(['auto', 'wayland', undefined])(
    'preserves the Linux display environment for %s mode',
    (preference) => {
      const environment = { WAYLAND_DISPLAY: 'wayland-0' };

      configureNativeWindowBackend({ platform: 'linux', preference, environment });

      expect(environment.WAYLAND_DISPLAY).toBe('wayland-0');
    },
  );

  test.each(['darwin', 'win32'] as const)(
    'never applies Linux display overrides on %s',
    (platform) => {
      const environment = { WAYLAND_DISPLAY: 'host-value' };

      configureNativeWindowBackend({ platform, preference: 'x11', environment });

      expect(environment.WAYLAND_DISPLAY).toBe('host-value');
    },
  );

  test('keeps native system chrome enabled with portable window constraints', () => {
    expect(NATIVE_CLIENT_WINDOW_OPTIONS).toMatchObject({
      title: 'Funny',
      appName: 'Funny',
      resizable: true,
      titlebarTransparent: false,
      windowBackground: 'opaque',
      minWidth: 800,
      minHeight: 600,
    });
  });
});
