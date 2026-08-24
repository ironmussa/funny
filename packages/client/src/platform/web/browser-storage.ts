import type { DiagnosticService, StorageChange, StorageService } from '@funny/client-core';

export interface BrowserStorageRuntime {
  storage: Storage;
  addStorageListener(listener: (event: StorageEvent) => void): () => void;
}

export function createBrowserStorageService(
  runtime: BrowserStorageRuntime,
  diagnostics: DiagnosticService,
): StorageService {
  const listeners = new Set<(change: StorageChange) => void>();
  let stopStorageEvents: (() => void) | null = null;
  const publish = (change: StorageChange): void => {
    for (const listener of listeners) listener(change);
  };
  const handleStorageEvent = (event: StorageEvent): void => {
    if (event.storageArea === runtime.storage && event.key) {
      publish({ key: event.key, value: event.newValue });
    }
  };

  const attempt = <T>(operation: string, fallback: T, callback: () => T): T => {
    try {
      return callback();
    } catch (error) {
      diagnostics.report({ capability: 'storage', operation, error });
      return fallback;
    }
  };

  return {
    read: (key) => attempt('read', null, () => runtime.storage.getItem(key)),
    write: (key, value) => {
      const written = attempt('write', false, () => {
        runtime.storage.setItem(key, value);
        return true;
      });
      if (written) publish({ key, value });
    },
    remove: (key) => {
      const removed = attempt('remove', false, () => {
        runtime.storage.removeItem(key);
        return true;
      });
      if (removed) publish({ key, value: null });
    },
    subscribe(listener) {
      if (listeners.size === 0) stopStorageEvents = runtime.addStorageListener(handleStorageEvent);
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          stopStorageEvents?.();
          stopStorageEvents = null;
        }
      };
    },
  };
}

export function browserStorageRuntime(win: Window): BrowserStorageRuntime {
  return {
    storage: win.localStorage,
    addStorageListener(listener) {
      win.addEventListener('storage', listener);
      return () => win.removeEventListener('storage', listener);
    },
  };
}
