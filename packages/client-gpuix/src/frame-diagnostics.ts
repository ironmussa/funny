import type { GpuixRenderer } from '@gpuix/native';

export const NATIVE_FRAME_OVERLAY_MODE = 'full' as const;
export const NATIVE_FRAME_OVERLAY_HIDDEN_MODE = 'hidden' as const;

type FrameDiagnosticsRenderer = Pick<
  GpuixRenderer,
  'resetDebugFrameOverlayStats' | 'setDebugFrameOverlay'
>;

type FrameDiagnosticsReader = Pick<
  GpuixRenderer,
  'getDebugFrameOverlay' | 'getDebugFrameOverlayStats'
>;

export interface NativeFrameDiagnostics {
  nativeFrameOverlayMode: string;
  nativeDrawCurrentMs: number | null;
  nativeDrawP90Ms: number | null;
  nativeDrawP99Ms: number | null;
  nativeDrawMaxMs: number | null;
  nativeDrawTotalFrames: number;
  nativeDrawSampleCount: number;
}

export function configureNativeFrameDiagnostics(
  renderer: FrameDiagnosticsRenderer,
  enabled: boolean,
): string {
  const activeMode = renderer.setDebugFrameOverlay(
    enabled ? NATIVE_FRAME_OVERLAY_MODE : NATIVE_FRAME_OVERLAY_HIDDEN_MODE,
  );
  if (enabled) resetNativeFrameDiagnostics(renderer);
  return activeMode;
}

export function resetNativeFrameDiagnostics(
  renderer: Pick<GpuixRenderer, 'resetDebugFrameOverlayStats'>,
): void {
  renderer.resetDebugFrameOverlayStats();
}

export function readNativeFrameDiagnostics(
  renderer: FrameDiagnosticsReader,
): NativeFrameDiagnostics {
  const stats = renderer.getDebugFrameOverlayStats();
  return {
    nativeFrameOverlayMode: renderer.getDebugFrameOverlay(),
    nativeDrawCurrentMs: stats.currentMs ?? null,
    nativeDrawP90Ms: stats.p90Ms ?? null,
    nativeDrawP99Ms: stats.p99Ms ?? null,
    nativeDrawMaxMs: stats.maxMs ?? null,
    nativeDrawTotalFrames: stats.frames,
    nativeDrawSampleCount: stats.samples,
  };
}
