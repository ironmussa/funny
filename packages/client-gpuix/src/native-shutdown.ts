const NATIVE_SHUTDOWN_MESSAGE = 'GPUI application is not initialized';

/**
 * Unmounts the React tree after GPUI has already shut down (the user closed the native host).
 * React still runs its cleanups, but GPUIX 0.11 then flushes the final mutation batch to the
 * stopped native app and throws; that error only means there is nothing left to draw on.
 */
export function unmountAfterNativeShutdown(root: { unmount(): void }): void {
  try {
    root.unmount();
  } catch (error) {
    if (!(error instanceof Error && error.message.includes(NATIVE_SHUTDOWN_MESSAGE))) throw error;
  }
}
