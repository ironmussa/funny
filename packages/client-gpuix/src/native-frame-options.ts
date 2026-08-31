import type { WindowOptions } from '@gpuix/native';

export const NATIVE_CLIENT_WINDOW_OPTIONS = {
  title: 'Funny',
  appName: 'Funny',
  width: 1440,
  height: 900,
  minWidth: 800,
  minHeight: 600,
  resizable: true,
  titlebarTransparent: false,
  windowBackground: 'opaque',
} as const satisfies WindowOptions;
