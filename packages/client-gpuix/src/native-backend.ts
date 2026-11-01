export type NativeLinuxWindowBackend = 'auto' | 'x11' | 'wayland';

type Environment = Record<string, string | undefined>;

interface NativeWindowBackendInput {
  platform: NodeJS.Platform;
  preference: string | undefined;
  environment: Environment;
}

interface NativeWindowBackendPlan {
  backend: NativeLinuxWindowBackend;
  /** Environment to relaunch with, when the current process cannot select the backend. */
  relaunchEnvironment: Environment | null;
}

export function resolveNativeLinuxWindowBackend(
  value: string | undefined,
): NativeLinuxWindowBackend {
  const normalized = value?.trim().toLowerCase();
  return normalized === 'x11' || normalized === 'wayland' ? normalized : 'auto';
}

/**
 * GNOME's compositor draws no server-side decorations for Wayland clients and GPUIX draws no
 * client-side titlebar, so the app would have no header to drag. Under XWayland mutter frames it.
 */
function lacksWaylandDecorations(environment: Environment): boolean {
  const desktop = environment.XDG_CURRENT_DESKTOP?.toUpperCase() ?? '';
  return desktop.split(':').includes('GNOME');
}

/**
 * Selects the Linux display backend. GPUI reads `WAYLAND_DISPLAY` from the native process
 * environment, which `process.env` writes do not reach, so X11 requires a relaunch without it.
 */
export function planNativeWindowBackend({
  platform,
  preference,
  environment,
}: NativeWindowBackendInput): NativeWindowBackendPlan {
  const requested = resolveNativeLinuxWindowBackend(preference);
  if (platform !== 'linux') return { backend: requested, relaunchEnvironment: null };

  const onWayland = Boolean(environment.WAYLAND_DISPLAY);
  const x11Available = Boolean(environment.DISPLAY);
  const backend =
    requested === 'auto' && onWayland && x11Available && lacksWaylandDecorations(environment)
      ? 'x11'
      : requested;

  if (backend !== 'x11' || !onWayland) return { backend, relaunchEnvironment: null };
  const { WAYLAND_DISPLAY: _wayland, ...relaunchEnvironment } = environment;
  return { backend, relaunchEnvironment };
}

const FORWARDED_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

/**
 * Passes termination signals from the launcher to the relaunched client. Without this, stopping
 * the launcher (`kill`, a closed terminal) orphans the child, which keeps running.
 */
export function forwardTerminationSignals(
  launcher: { on(signal: NodeJS.Signals, listener: () => void): unknown },
  child: { kill(signal: NodeJS.Signals): unknown },
): void {
  for (const signal of FORWARDED_SIGNALS) launcher.on(signal, () => child.kill(signal));
}
