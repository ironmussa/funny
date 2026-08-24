import type {
  ClientDiagnostic,
  ClientHttpRequest,
  ClientHttpResponse,
  ClientLocation,
  ClientPlatform,
  LifecycleSnapshot,
  SemanticEffect,
  StorageChange,
  TransportEnvironment,
} from '../platform';

export interface InMemoryPlatformOptions {
  storage?: Readonly<Record<string, string>>;
  location?: Partial<ClientLocation>;
  lifecycle?: Partial<LifecycleSnapshot>;
  environment?: Partial<TransportEnvironment>;
  request?: (request: ClientHttpRequest) => Promise<ClientHttpResponse>;
}

export interface InMemoryPlatformControls {
  readonly effects: readonly SemanticEffect[];
  readonly diagnostics: readonly ClientDiagnostic[];
  readonly requests: readonly ClientHttpRequest[];
  setLocation(location: Partial<ClientLocation>): void;
  setLifecycle(snapshot: Partial<LifecycleSnapshot>): void;
  setStorage(key: string, value: string | null): void;
  storageSnapshot(): Readonly<Record<string, string>>;
}

export interface InMemoryPlatformHost {
  platform: ClientPlatform;
  controls: InMemoryPlatformControls;
}

export function createInMemoryPlatform(
  options: InMemoryPlatformOptions = {},
): InMemoryPlatformHost {
  const values = new Map(Object.entries(options.storage ?? {}));
  const storageListeners = new Set<(change: StorageChange) => void>();
  const navigationListeners = new Set<(location: ClientLocation) => void>();
  const lifecycleListeners = new Set<(snapshot: LifecycleSnapshot) => void>();
  const effects: SemanticEffect[] = [];
  const diagnostics: ClientDiagnostic[] = [];
  const requests: ClientHttpRequest[] = [];
  let location: ClientLocation = {
    pathname: options.location?.pathname ?? '/',
    search: options.location?.search ?? '',
    hash: options.location?.hash ?? '',
  };
  let lifecycle: LifecycleSnapshot = {
    focused: options.lifecycle?.focused ?? true,
    visible: options.lifecycle?.visible ?? true,
  };

  const publishStorage = (key: string, value: string | null): void => {
    const change = { key, value };
    for (const listener of storageListeners) listener(change);
  };

  const platform: ClientPlatform = {
    storage: {
      read: (key) => values.get(key) ?? null,
      write: (key, value) => {
        values.set(key, value);
        publishStorage(key, value);
      },
      remove: (key) => {
        values.delete(key);
        publishStorage(key, null);
      },
      subscribe: (listener) => {
        storageListeners.add(listener);
        return () => storageListeners.delete(listener);
      },
    },
    navigation: {
      current: () => ({ ...location }),
      navigate: (next) => {
        location = { ...next };
        for (const listener of navigationListeners) listener({ ...location });
      },
      subscribe: (listener) => {
        navigationListeners.add(listener);
        return () => navigationListeners.delete(listener);
      },
    },
    lifecycle: {
      current: () => ({ ...lifecycle }),
      subscribe: (listener) => {
        lifecycleListeners.add(listener);
        return () => lifecycleListeners.delete(listener);
      },
    },
    transport: {
      environment: {
        hostMode: options.environment?.hostMode ?? 'browser',
        pageOrigin: options.environment?.pageOrigin ?? 'http://localhost',
        localServerPort: options.environment?.localServerPort ?? 5002,
        remoteOriginAllowlist: options.environment?.remoteOriginAllowlist ?? [],
      },
      request: async (request) => {
        requests.push(request);
        if (options.request) return options.request(request);
        return {
          status: 200,
          ok: true,
          headers: {},
          text: async () => '',
        };
      },
    },
    effects: { emit: (effect) => effects.push(effect) },
    diagnostics: { report: (diagnostic) => diagnostics.push(diagnostic) },
  };

  return {
    platform,
    controls: {
      effects,
      diagnostics,
      requests,
      setLocation(next) {
        platform.navigation.navigate({ ...location, ...next });
      },
      setLifecycle(next) {
        lifecycle = { ...lifecycle, ...next };
        for (const listener of lifecycleListeners) listener({ ...lifecycle });
      },
      setStorage(key, value) {
        if (value === null) platform.storage.remove(key);
        else platform.storage.write(key, value);
      },
      storageSnapshot: () => Object.fromEntries(values),
    },
  };
}
