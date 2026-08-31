export const VISUAL_THEME_NAMES = ['reference-dark', 'one-dark'] as const;
export type VisualThemeName = (typeof VISUAL_THEME_NAMES)[number];
export type VisualDensity = 'compact' | 'comfortable';

export interface VisualColors {
  canvas: string;
  sidebar: string;
  surface: string;
  surfaceRaised: string;
  input: string;
  overlay: string;
  border: string;
  borderStrong: string;
  text: string;
  textMuted: string;
  accent: string;
  accentText: string;
  inverseSurface: string;
  inverseText: string;
  success: string;
  warning: string;
  danger: string;
  dangerSurface: string;
  info: string;
}

export interface VisualContract {
  name: VisualThemeName;
  colors: VisualColors;
  spacing: { xsmall: number; small: number; medium: number; large: number; xlarge: number };
  radii: { small: number; medium: number; large: number; pill: number };
  typography: {
    caption: number;
    body: number;
    title: number;
    lineHeightBody: number;
    weightMedium: number;
    weightStrong: number;
  };
  controls: { xsmall: number; small: number; medium: number; large: number; icon: number };
  layout: {
    sidebarWidth: number;
    sidebarMinimumWidth: number;
    compactBreakpoint: number;
    conversationMaximumWidth: number;
    composerMaximumWidth: number;
    headerHeight: number;
  };
}

export const referenceDark: VisualContract = {
  name: 'reference-dark',
  colors: {
    canvas: '#1b1e23',
    sidebar: '#14171a',
    surface: '#121417',
    surfaceRaised: '#22272e',
    input: '#282d33',
    overlay: '#121417',
    border: '#3d444f',
    borderStrong: '#528bff',
    text: '#c8cbd0',
    textMuted: '#838993',
    accent: '#22272e',
    accentText: '#dfe2e6',
    inverseSurface: '#c8cbd0',
    inverseText: '#1b1e23',
    success: '#4ade80',
    warning: '#facc15',
    danger: '#e06c75',
    dangerSurface: '#45272b',
    info: '#528bff',
  },
  spacing: { xsmall: 4, small: 8, medium: 12, large: 16, xlarge: 24 },
  radii: { small: 4, medium: 6, large: 8, pill: 999 },
  typography: {
    caption: 11,
    body: 14,
    title: 16,
    lineHeightBody: 20,
    weightMedium: 500,
    weightStrong: 600,
  },
  controls: { xsmall: 24, small: 28, medium: 34, large: 40, icon: 16 },
  layout: {
    sidebarWidth: 300,
    sidebarMinimumWidth: 260,
    compactBreakpoint: 860,
    conversationMaximumWidth: 768,
    composerMaximumWidth: 768,
    headerHeight: 44,
  },
};

/** React's default `.theme-one-dark`, published as a selectable renderer-neutral theme. */
export const oneDark: VisualContract = {
  ...referenceDark,
  name: 'one-dark',
  colors: { ...referenceDark.colors },
  spacing: { ...referenceDark.spacing },
  radii: { ...referenceDark.radii },
  typography: { ...referenceDark.typography },
  controls: { ...referenceDark.controls },
  layout: { ...referenceDark.layout },
};

export const visualThemes: Readonly<Record<VisualThemeName, VisualContract>> = {
  'reference-dark': referenceDark,
  'one-dark': oneDark,
};

export function isVisualThemeName(value: unknown): value is VisualThemeName {
  return typeof value === 'string' && VISUAL_THEME_NAMES.includes(value as VisualThemeName);
}

export function visualContract(name: VisualThemeName = 'reference-dark'): VisualContract {
  return visualThemes[name];
}
