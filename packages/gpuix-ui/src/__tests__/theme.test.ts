import { describe, expect, test } from 'bun:test';

import { oneDark, referenceDark } from '@funny/ui-contracts/tokens';

import {
  createGpuixThemeFromContract,
  createGpuixUiTheme,
  darkTheme,
  gpuixTheme,
  oneDarkTheme,
} from '../theme';

describe('gpuix-ui theme', () => {
  test('merges partial sections without mutating the default theme', () => {
    const theme = createGpuixUiTheme({ colors: { accent: '#123456' }, radii: { medium: 12 } });

    expect(theme.colors.accent).toBe('#123456');
    expect(theme.colors.text).toBe(darkTheme.colors.text);
    expect(theme.radii.medium).toBe(12);
    expect(darkTheme.colors.accent).not.toBe('#123456');
  });

  test('maps the renderer-neutral visual contract', () => {
    const theme = createGpuixThemeFromContract(referenceDark);
    expect(theme.colors.background).toBe(referenceDark.colors.canvas);
    expect(theme.colors.panel).toBe(referenceDark.colors.sidebar);
    expect(theme.colors.borderStrong).toBe(referenceDark.colors.borderStrong);
    expect(theme.radii.large).toBe(referenceDark.radii.large);
  });

  test('resolves the named one-dark theme used by React', () => {
    expect(gpuixTheme('one-dark')).toEqual(oneDarkTheme);
    expect(oneDarkTheme.colors.background).toBe(oneDark.colors.canvas);
    expect(darkTheme).toBe(oneDarkTheme);
  });
});
