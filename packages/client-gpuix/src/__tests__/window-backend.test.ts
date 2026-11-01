import { describe, expect, test } from 'bun:test';

import {
  forwardTerminationSignals,
  planNativeWindowBackend,
  resolveNativeLinuxWindowBackend,
} from '../native-backend';
import { NATIVE_CLIENT_WINDOW_OPTIONS } from '../native-frame-options';

describe('native GPUIX window backend', () => {
  test('normalizes supported values and defaults missing or invalid values to auto', () => {
    expect(resolveNativeLinuxWindowBackend(' X11 ')).toBe('x11');
    expect(resolveNativeLinuxWindowBackend('WAYLAND')).toBe('wayland');
    expect(resolveNativeLinuxWindowBackend('auto')).toBe('auto');
    expect(resolveNativeLinuxWindowBackend(undefined)).toBe('auto');
    expect(resolveNativeLinuxWindowBackend('unsupported')).toBe('auto');
  });

  const gnomeWayland = {
    WAYLAND_DISPLAY: 'wayland-0',
    DISPLAY: ':0',
    XDG_CURRENT_DESKTOP: 'zorin:GNOME',
  };

  test('relaunches without WAYLAND_DISPLAY in x11 mode', () => {
    const plan = planNativeWindowBackend({
      platform: 'linux',
      preference: 'x11',
      environment: { WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0', HOME: '/home/u' },
    });

    expect(plan.backend).toBe('x11');
    expect(plan.relaunchEnvironment).toEqual({ DISPLAY: ':0', HOME: '/home/u' });
  });

  test('defaults GNOME Wayland sessions to x11 so the window manager draws a titlebar', () => {
    const plan = planNativeWindowBackend({
      platform: 'linux',
      preference: undefined,
      environment: gnomeWayland,
    });

    expect(plan.backend).toBe('x11');
    expect(plan.relaunchEnvironment).not.toHaveProperty('WAYLAND_DISPLAY');
  });

  test('does not relaunch again once WAYLAND_DISPLAY is gone', () => {
    const { WAYLAND_DISPLAY: _wayland, ...relaunched } = gnomeWayland;

    expect(
      planNativeWindowBackend({ platform: 'linux', preference: 'auto', environment: relaunched })
        .relaunchEnvironment,
    ).toBeNull();
  });

  test.each([
    ['explicit wayland on GNOME', 'wayland', gnomeWayland],
    ['auto without XWayland', 'auto', { ...gnomeWayland, DISPLAY: undefined }],
    ['auto on a decorating compositor', 'auto', { ...gnomeWayland, XDG_CURRENT_DESKTOP: 'KDE' }],
  ])('keeps Wayland for %s', (_name, preference, environment) => {
    expect(
      planNativeWindowBackend({ platform: 'linux', preference, environment }).relaunchEnvironment,
    ).toBeNull();
  });

  test.each(['darwin', 'win32'] as const)(
    'never applies Linux display overrides on %s',
    (platform) => {
      expect(
        planNativeWindowBackend({ platform, preference: 'x11', environment: gnomeWayland })
          .relaunchEnvironment,
      ).toBeNull();
    },
  );

  test('forwards termination signals so the relaunched client does not outlive its launcher', () => {
    const listeners = new Map<string, () => void>();
    const killed: string[] = [];
    forwardTerminationSignals(
      { on: (signal, listener) => listeners.set(signal, listener) },
      { kill: (signal) => killed.push(signal) },
    );

    for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) listeners.get(signal)?.();

    expect(killed).toEqual(['SIGTERM', 'SIGINT', 'SIGHUP']);
  });

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
