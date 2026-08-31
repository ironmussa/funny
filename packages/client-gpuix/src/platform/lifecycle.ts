import type { LifecycleService, LifecycleSnapshot, Unsubscribe } from '@funny/client-core';

export const NATIVE_HOST_FOCUS_EVIDENCE = {
  supported: false,
  runtime: 'GPUIX 0.5.1',
  reason: 'independent host-focus signal unavailable',
} as const;

export class NativeLifecycleService implements LifecycleService {
  private snapshot: LifecycleSnapshot = { focused: true, visible: true };
  private readonly listeners = new Set<(snapshot: LifecycleSnapshot) => void>();

  current(): LifecycleSnapshot {
    return { ...this.snapshot };
  }

  update(next: Partial<LifecycleSnapshot>): void {
    const updated = { ...this.snapshot, ...next };
    if (updated.focused === this.snapshot.focused && updated.visible === this.snapshot.visible)
      return;
    this.snapshot = updated;
    for (const listener of this.listeners) listener(this.current());
  }

  markWindowTerminated(): void {
    this.update({ focused: false, visible: false });
  }

  subscribe(listener: (snapshot: LifecycleSnapshot) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
