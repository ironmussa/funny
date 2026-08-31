import type { DiagnosticService } from '@funny/client-core';
import { Component, type ErrorInfo, type ReactElement, type ReactNode } from 'react';

export const NATIVE_RENDERER_ERROR_PALETTE = {
  background: '#111318',
  foreground: '#f5f7fa',
  muted: '#b8c0cc',
  danger: '#ff8f8f',
  border: '#394150',
} as const;

export function NativeRendererFailureSurface({ error }: { error: string }): ReactElement {
  return (
    <div
      testId="native-renderer-error"
      style={{
        display: 'flex',
        flexDirection: 'column',
        width: '100%',
        height: '100%',
        padding: 24,
        gap: 10,
        backgroundColor: NATIVE_RENDERER_ERROR_PALETTE.background,
        color: NATIVE_RENDERER_ERROR_PALETTE.foreground,
        borderWidth: 1,
        borderColor: NATIVE_RENDERER_ERROR_PALETTE.border,
      }}
    >
      <text style={{ color: NATIVE_RENDERER_ERROR_PALETTE.danger, fontSize: 20 }}>
        Native renderer recovered from an error
      </text>
      <text style={{ color: NATIVE_RENDERER_ERROR_PALETTE.foreground }}>{error}</text>
      <text style={{ color: NATIVE_RENDERER_ERROR_PALETTE.muted }}>
        Restart GPUIX or run `bun run dev:client` to use the web renderer.
      </text>
    </div>
  );
}

export class NativeRendererErrorBoundary extends Component<
  { children: ReactNode; diagnostics: DiagnosticService },
  { error: string | null }
> {
  state = { error: null as string | null };

  static getDerivedStateFromError(error: unknown): { error: string } {
    return { error: error instanceof Error ? error.message : String(error) };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    this.props.diagnostics.report({
      capability: 'platform',
      operation: 'renderer.crash',
      error: new Error(`${error.message}\n${info.componentStack ?? ''}`),
    });
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return <NativeRendererFailureSurface error={this.state.error} />;
  }
}
