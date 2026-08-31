import { describe, expect, mock, test } from 'bun:test';

import {
  configureNativeFrameDiagnostics,
  NATIVE_FRAME_OVERLAY_HIDDEN_MODE,
  NATIVE_FRAME_OVERLAY_MODE,
  readNativeFrameDiagnostics,
  resetNativeFrameDiagnostics,
} from '../frame-diagnostics';

describe('native frame diagnostics', () => {
  test('keeps the native overlay hidden without resetting samples by default', () => {
    const setDebugFrameOverlay = mock(() => 'hidden');
    const resetDebugFrameOverlayStats = mock(() => undefined);

    expect(
      configureNativeFrameDiagnostics(
        { setDebugFrameOverlay, resetDebugFrameOverlayStats } as never,
        false,
      ),
    ).toBe('hidden');
    expect(NATIVE_FRAME_OVERLAY_HIDDEN_MODE).toBe('hidden');
    expect(setDebugFrameOverlay).toHaveBeenCalledWith('hidden');
    expect(resetDebugFrameOverlayStats).not.toHaveBeenCalled();
  });

  test('explicitly enables the full native overlay and starts with clean samples', () => {
    const setDebugFrameOverlay = mock(() => 'full');
    const resetDebugFrameOverlayStats = mock(() => undefined);

    expect(
      configureNativeFrameDiagnostics(
        { setDebugFrameOverlay, resetDebugFrameOverlayStats } as never,
        true,
      ),
    ).toBe('full');
    expect(NATIVE_FRAME_OVERLAY_MODE).toBe('full');
    expect(setDebugFrameOverlay).toHaveBeenCalledWith('full');
    expect(resetDebugFrameOverlayStats).toHaveBeenCalledTimes(1);
  });

  test('resets accumulated samples on demand', () => {
    const resetDebugFrameOverlayStats = mock(() => undefined);

    resetNativeFrameDiagnostics({ resetDebugFrameOverlayStats } as never);

    expect(resetDebugFrameOverlayStats).toHaveBeenCalledTimes(1);
  });

  test('exports aggregate native draw statistics as renderer diagnostics', () => {
    expect(
      readNativeFrameDiagnostics({
        getDebugFrameOverlay: () => 'full',
        getDebugFrameOverlayStats: () => ({
          currentMs: 1.25,
          p90Ms: 2.5,
          p99Ms: 4.75,
          maxMs: 8,
          frames: 120,
          samples: 100,
        }),
      } as never),
    ).toEqual({
      nativeFrameOverlayMode: 'full',
      nativeDrawCurrentMs: 1.25,
      nativeDrawP90Ms: 2.5,
      nativeDrawP99Ms: 4.75,
      nativeDrawMaxMs: 8,
      nativeDrawTotalFrames: 120,
      nativeDrawSampleCount: 100,
    });
  });

  test('records unavailable draw percentiles as null', () => {
    expect(
      readNativeFrameDiagnostics({
        getDebugFrameOverlay: () => 'full',
        getDebugFrameOverlayStats: () => ({ frames: 0, samples: 0 }),
      } as never),
    ).toMatchObject({
      nativeDrawCurrentMs: null,
      nativeDrawP90Ms: null,
      nativeDrawP99Ms: null,
      nativeDrawMaxMs: null,
    });
  });
});
