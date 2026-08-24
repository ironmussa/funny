import type { DiagnosticService, StorageService, Unsubscribe } from '../platform';

export interface PersistedValue<T> {
  read(): T;
  write(value: T): void;
  subscribe(listener: (value: T) => void): Unsubscribe;
}

export interface PersistedValueOptions<T> {
  storage: StorageService;
  diagnostics: DiagnosticService;
  key: string;
  fallback: () => T;
  decode(raw: string): T;
  encode(value: T): string;
  removeMalformed?: boolean;
}

export function createPersistedValue<T>(options: PersistedValueOptions<T>): PersistedValue<T> {
  const decode = (raw: string | null): T => {
    if (raw === null) return options.fallback();
    try {
      return options.decode(raw);
    } catch (error) {
      options.diagnostics.report({
        capability: 'storage',
        operation: `decode:${options.key}`,
        error,
      });
      if (options.removeMalformed) options.storage.remove(options.key);
      return options.fallback();
    }
  };

  return {
    read: () => decode(options.storage.read(options.key)),
    write: (value) => options.storage.write(options.key, options.encode(value)),
    subscribe: (listener) =>
      options.storage.subscribe((change) => {
        if (change.key === options.key) listener(decode(change.value));
      }),
  };
}
