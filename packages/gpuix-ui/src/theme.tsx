import { oneDark, referenceDark, visualContract } from '@funny/ui-contracts/tokens';
import type { VisualContract, VisualThemeName } from '@funny/ui-contracts/tokens';
import { createContext, use } from 'react';
import type { ReactElement, ReactNode } from 'react';

export interface GpuixUiColors {
  background: string;
  panel: string;
  raised: string;
  overlay: string;
  border: string;
  borderStrong: string;
  text: string;
  muted: string;
  accent: string;
  accentForeground: string;
  inverseText: string;
  success: string;
  warning: string;
  danger: string;
  dangerSurface: string;
}

export interface GpuixUiRadii {
  small: number;
  medium: number;
  large: number;
  pill: number;
}

export interface GpuixUiSpacing {
  xsmall: number;
  small: number;
  medium: number;
  large: number;
}

export interface GpuixUiFontSizes {
  caption: number;
  body: number;
  title: number;
}

export interface GpuixUiTheme {
  colors: GpuixUiColors;
  radii: GpuixUiRadii;
  spacing: GpuixUiSpacing;
  fontSizes: GpuixUiFontSizes;
}

export type GpuixUiThemeOverride = {
  [Section in keyof GpuixUiTheme]?: Partial<GpuixUiTheme[Section]>;
};

export function createGpuixThemeFromContract(contract: VisualContract): GpuixUiTheme {
  return {
    colors: {
      background: contract.colors.canvas,
      panel: contract.colors.sidebar,
      raised: contract.colors.surfaceRaised,
      overlay: contract.colors.overlay,
      border: contract.colors.border,
      borderStrong: contract.colors.borderStrong,
      text: contract.colors.text,
      muted: contract.colors.textMuted,
      accent: contract.colors.accent,
      accentForeground: contract.colors.accentText,
      inverseText: contract.colors.inverseText,
      success: contract.colors.success,
      warning: contract.colors.warning,
      danger: contract.colors.danger,
      dangerSurface: contract.colors.dangerSurface,
    },
    radii: { ...contract.radii },
    spacing: {
      xsmall: contract.spacing.xsmall,
      small: contract.spacing.small,
      medium: contract.spacing.medium,
      large: contract.spacing.large,
    },
    fontSizes: {
      caption: contract.typography.caption,
      body: contract.typography.body,
      title: contract.typography.title,
    },
  };
}

export const oneDarkTheme: GpuixUiTheme = createGpuixThemeFromContract(oneDark);
export const darkTheme: GpuixUiTheme = oneDarkTheme;

export function gpuixTheme(name: VisualThemeName): GpuixUiTheme {
  return createGpuixThemeFromContract(visualContract(name));
}

export function createGpuixUiTheme(override: GpuixUiThemeOverride = {}): GpuixUiTheme {
  return {
    colors: { ...darkTheme.colors, ...override.colors },
    radii: { ...darkTheme.radii, ...override.radii },
    spacing: { ...darkTheme.spacing, ...override.spacing },
    fontSizes: { ...darkTheme.fontSizes, ...override.fontSizes },
  };
}

const ThemeContext = createContext<GpuixUiTheme>(darkTheme);

export function GpuixUiProvider({
  children,
  theme = darkTheme,
}: {
  children: ReactNode;
  theme?: GpuixUiTheme;
}): ReactElement {
  return <ThemeContext value={theme}>{children}</ThemeContext>;
}

export function useGpuixUiTheme(): GpuixUiTheme {
  return use(ThemeContext);
}
