import type { StorageService } from '@funny/client-core';
import {
  normalizeDockLayout,
  type DockLayoutState,
  type DockPanelConstraints,
} from '@funny/gpuix-ui/dock-layout-model';

export const NATIVE_DOCK_LAYOUT_STORAGE_KEY = 'dock-layout';

const NATIVE_DOCK_PANELS: readonly DockPanelConstraints[] = [
  { id: 'navigation', defaultSize: 300, minSize: 260, maxSize: 600 },
  { id: 'conversation', minSize: 400 },
  { id: 'files', defaultSize: 300, minSize: 240, maxSize: 600 },
];

const NATIVE_DOCK_LAYOUT_VERSION = 2;

export function resolveNativeDockLayout(value: string | null): DockLayoutState {
  if (!value) return normalizeDockLayout(NATIVE_DOCK_PANELS);
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return normalizeDockLayout(NATIVE_DOCK_PANELS);
    }
    const storedOrder = 'order' in parsed ? parsed.order : undefined;
    const storedSizes = 'sizes' in parsed ? parsed.sizes : undefined;
    const order = Array.isArray(storedOrder)
      ? storedOrder.filter((id): id is string => typeof id === 'string')
      : undefined;
    const legacyLayout =
      ('version' in parsed ? parsed.version : undefined) !== NATIVE_DOCK_LAYOUT_VERSION;
    if (order && legacyLayout) {
      const filesIndex = order.indexOf('files');
      if (filesIndex >= 0) order.splice(filesIndex, 1);
      order.push('files');
    }
    // SAFETY: normalizeDockLayout drops every size that is not a finite positive number
    // (`finitePositive`), so a non-number value read from storage never reaches the layout.
    const sizes =
      storedSizes && typeof storedSizes === 'object' && !Array.isArray(storedSizes)
        ? (storedSizes as Record<string, number>)
        : undefined;
    const normalized = normalizeDockLayout(NATIVE_DOCK_PANELS, { order, sizes });
    return legacyLayout
      ? { ...normalized, order: [...normalized.order.filter((id) => id !== 'files'), 'files'] }
      : normalized;
  } catch {
    return normalizeDockLayout(NATIVE_DOCK_PANELS);
  }
}

export class NativeDockLayoutPreference {
  private layout: DockLayoutState;

  constructor(private readonly storage: StorageService) {
    this.layout = resolveNativeDockLayout(storage.read(NATIVE_DOCK_LAYOUT_STORAGE_KEY));
  }

  current(): DockLayoutState {
    return this.layout;
  }

  save(value: DockLayoutState): void {
    const visibleIds = new Set(value.order);
    let visibleIndex = 0;
    const mergedOrder = this.layout.order.map((id) =>
      visibleIds.has(id) ? (value.order[visibleIndex++] ?? id) : id,
    );
    const mergedIds = new Set(mergedOrder);
    for (const id of value.order) {
      if (!mergedIds.has(id)) {
        mergedOrder.push(id);
        mergedIds.add(id);
      }
    }
    this.layout = normalizeDockLayout(NATIVE_DOCK_PANELS, {
      order: mergedOrder,
      sizes: { ...this.layout.sizes, ...value.sizes },
    });
    this.storage.write(
      NATIVE_DOCK_LAYOUT_STORAGE_KEY,
      JSON.stringify({ version: NATIVE_DOCK_LAYOUT_VERSION, ...this.layout }),
    );
  }
}
