import { collectGarbageWhenIdle, createRenderer, createRoot, startFrameLoop } from '@gpuix/react';

import { GpuixClientApp } from './app';
import type { NativeApplicationServices } from './application';
import { configureNativeFrameDiagnostics, resetNativeFrameDiagnostics } from './frame-diagnostics';
import { NATIVE_CLIENT_WINDOW_OPTIONS } from './native-frame-options';
import { unmountAfterNativeShutdown } from './native-shutdown';
import type { NativeClientComposition } from './platform/composition';
import { NativeRendererErrorBoundary } from './renderer-error-boundary';

export function startNativeClient(
  composition: NativeClientComposition,
  application: NativeApplicationServices,
  diagnostics = false,
  /** Called once the user has closed the native host and cleanup has run. */
  onClosed?: () => void,
): { stop(): void } {
  const renderer = createRenderer();
  renderer.init(NATIVE_CLIENT_WINDOW_OPTIONS);
  configureNativeFrameDiagnostics(renderer, diagnostics);
  const resetFrameStats = () => resetNativeFrameDiagnostics(renderer);
  const root = createRoot(renderer);
  root.render(
    <NativeRendererErrorBoundary diagnostics={composition.platform.diagnostics}>
      <GpuixClientApp
        application={application}
        diagnostics={diagnostics}
        onResetFrameStats={diagnostics ? resetFrameStats : undefined}
      />
    </NativeRendererErrorBoundary>,
  );
  // Return the heap to baseline after bursts (initial mount, streaming, opening large threads).
  const stopIdleGc = collectGarbageWhenIdle();
  const frameLoop = startFrameLoop(renderer, {
    onTerminated: () => {
      stopIdleGc();
      composition.lifecycle.markWindowTerminated();
      application.dispose();
      unmountAfterNativeShutdown(root);
      onClosed?.();
    },
  });
  return {
    stop(): void {
      stopIdleGc();
      composition.lifecycle.markWindowTerminated();
      application.dispose();
      frameLoop.stop();
      root.unmount();
    },
  };
}
