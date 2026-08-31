export type NativeLinuxWindowBackend = 'auto' | 'x11' | 'wayland';

interface NativeWindowBackendInput {
  platform: NodeJS.Platform;
  preference: string | undefined;
  environment: Record<string, string | undefined>;
}

export function resolveNativeLinuxWindowBackend(
  value: string | undefined,
): NativeLinuxWindowBackend {
  const normalized = value?.trim().toLowerCase();
  return normalized === 'x11' || normalized === 'wayland' ? normalized : 'auto';
}

/** Selects X11 before the native GPUIX module is loaded. */
export function configureNativeWindowBackend({
  platform,
  preference,
  environment,
}: NativeWindowBackendInput): NativeLinuxWindowBackend {
  const backend = resolveNativeLinuxWindowBackend(preference);
  if (platform === 'linux' && backend === 'x11') {
    environment.WAYLAND_DISPLAY = '';
  }
  return backend;
}
