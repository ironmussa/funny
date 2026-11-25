import type { DockviewApi, SerializedDockview } from 'dockview-react';

/** Persist the layout at most every 500ms — splitter drags fire dozens of
 *  layout-change events and we don't want to thrash localStorage. */
export const LAYOUT_PERSIST_DEBOUNCE_MS = 500;

export function readStoredSize(key: string): number | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

export function writeStoredSize(key: string, size: number) {
  // Dockview fires `onDidLayoutChange` during initial setup with intermediate
  // values; persisting 0/NaN would clobber the real saved value.
  if (!Number.isFinite(size) || size < 1) return;
  try {
    localStorage.setItem(key, String(Math.round(size)));
  } catch {
    /* ignore quota / privacy-mode errors */
  }
}

/** Minimum-shape check of a stored layout; anything richer is for fromJSON to reject. */
function isSerializedDockview(value: unknown): value is SerializedDockview {
  return typeof value === 'object' && value !== null && 'grid' in value && 'panels' in value;
}

function readStoredLayout(key: string): SerializedDockview | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (isSerializedDockview(parsed)) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

export function writeStoredLayout(key: string, layout: SerializedDockview) {
  try {
    localStorage.setItem(key, JSON.stringify(layout));
  } catch {
    /* ignore quota / privacy-mode errors */
  }
}

function clearStoredLayout(key: string) {
  try {
    localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

/**
 * Restore the layout saved under `storageKey` into `api`. Returns true when
 * it was restored and `reconcile` accepted it. Otherwise (no blob, a blob
 * `fromJSON` rejects, or one `reconcile` refuses) the bad blob is cleared and
 * any partial state is wiped; `beforeClose` sees each panel id first.
 */
export function restoreStoredLayout(
  api: DockviewApi,
  storageKey: string,
  reconcile: (api: DockviewApi) => boolean,
  beforeClose?: (panelId: string) => void,
): boolean {
  const storedLayout = readStoredLayout(storageKey);
  if (!storedLayout) return false;
  try {
    api.fromJSON(storedLayout);
    if (reconcile(api)) return true;
  } catch {
    /* fromJSON may have left the dockview in a partial state — wiped below */
  }
  clearStoredLayout(storageKey);
  for (const p of [...api.panels]) {
    beforeClose?.(p.id);
    p.api.close();
  }
  return false;
}
