import { createRenderer, createRoot, startFrameLoop } from '@gpuix/react';

import { GpuixClientApp } from './app';
import type { NativeApplicationServices } from './application';
import { configureNativeFrameDiagnostics, resetNativeFrameDiagnostics } from './frame-diagnostics';
import { NATIVE_CLIENT_WINDOW_OPTIONS } from './native-frame-options';
import type { NativeClientComposition } from './platform/composition';
import { NativeRendererErrorBoundary } from './renderer-error-boundary';

export function startNativeClient(
  composition: NativeClientComposition,
  application: NativeApplicationServices,
  diagnostics = false,
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
  const frameLoop = startFrameLoop(renderer, {
    onTerminated: () => {
      composition.lifecycle.markWindowTerminated();
      application.dispose();
      root.unmount();
    },
  });
  return {
    stop(): void {
      composition.lifecycle.markWindowTerminated();
      application.dispose();
      frameLoop.stop();
      root.unmount();
    },
  };
}
