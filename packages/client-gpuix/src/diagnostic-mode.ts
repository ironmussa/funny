export function resolveNativeDiagnosticMode(value: string | undefined): boolean {
  return value === 'true';
}

export function nativeRenderingModeLabel(richContent: boolean): string {
  return `Rendering: ${richContent ? 'Rich' : 'Fast'}`;
}

export const diagnosticSurfacePosition = {
  position: 'absolute',
  right: 6,
  bottom: 6,
} as const;
