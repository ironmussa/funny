export type Unsubscribe = () => void;

export interface ClientDiagnostic {
  capability: keyof ClientPlatform | 'platform';
  operation: string;
  error: unknown;
  optional?: boolean;
}

export interface DiagnosticService {
  report(diagnostic: ClientDiagnostic): void;
}

export interface StorageChange {
  key: string;
  value: string | null;
}

export interface StorageService {
  read(key: string): string | null;
  write(key: string, value: string): void;
  remove(key: string): void;
  subscribe(listener: (change: StorageChange) => void): Unsubscribe;
}

export interface ClientLocation {
  pathname: string;
  search: string;
  hash: string;
}

export interface NavigationOptions {
  replace?: boolean;
}

export interface NavigationService {
  current(): ClientLocation;
  navigate(to: ClientLocation, options?: NavigationOptions): void;
  subscribe(listener: (location: ClientLocation) => void): Unsubscribe;
}

export type HostMode = 'browser' | 'tauri';

export interface TransportEnvironment {
  hostMode: HostMode;
  pageOrigin: string;
  localServerPort: number;
  remoteOriginAllowlist: readonly string[];
}

export interface ClientHttpRequest {
  url: string;
  method?: string;
  headers?: Readonly<Record<string, string>>;
  body?: string;
  cancellation?: ClientCancellation;
}

export interface ClientCancellation {
  readonly aborted: boolean;
  subscribe(listener: () => void): Unsubscribe;
}

export interface ClientHttpResponse {
  status: number;
  ok: boolean;
  headers: Readonly<Record<string, string>>;
  text(): Promise<string>;
}

export interface TransportService {
  readonly environment: TransportEnvironment;
  request(request: ClientHttpRequest): Promise<ClientHttpResponse>;
}

export interface LifecycleSnapshot {
  focused: boolean;
  visible: boolean;
}

export interface LifecycleService {
  current(): LifecycleSnapshot;
  subscribe(listener: (snapshot: LifecycleSnapshot) => void): Unsubscribe;
}

export type SemanticEffect =
  | {
      type: 'toast';
      level: 'info' | 'success' | 'warning' | 'error';
      message: string;
      description?: string;
    }
  | { type: 'notification'; title: string; body?: string; tag?: string }
  | { type: 'application-event'; name: string; detail?: unknown };

export interface EffectService {
  emit(effect: SemanticEffect): void;
}

export interface ClientPlatform {
  storage: StorageService;
  navigation: NavigationService;
  transport: TransportService;
  lifecycle: LifecycleService;
  effects: EffectService;
  diagnostics: DiagnosticService;
}

const REQUIRED_METHODS = {
  storage: ['read', 'write', 'remove', 'subscribe'],
  navigation: ['current', 'navigate', 'subscribe'],
  transport: ['request'],
  lifecycle: ['current', 'subscribe'],
  effects: ['emit'],
  diagnostics: ['report'],
} as const satisfies Record<keyof ClientPlatform, readonly string[]>;

export class InvalidClientPlatformError extends Error {
  readonly missing: readonly string[];

  constructor(missing: readonly string[]) {
    super(`Invalid client platform; missing capabilities: ${missing.join(', ')}`);
    this.name = 'InvalidClientPlatformError';
    this.missing = missing;
  }
}

export function validateClientPlatform(candidate: unknown): asserts candidate is ClientPlatform {
  const value = candidate as Partial<Record<keyof ClientPlatform, unknown>> | null;
  const missing: string[] = [];

  for (const [capability, methods] of Object.entries(REQUIRED_METHODS)) {
    const service = value?.[capability as keyof ClientPlatform] as Record<string, unknown> | null;
    if (!service || typeof service !== 'object') {
      missing.push(capability);
      continue;
    }
    for (const method of methods) {
      if (typeof service[method] !== 'function') missing.push(`${capability}.${method}`);
    }
  }

  const transport = value?.transport as { environment?: unknown } | undefined;
  if (transport && (!transport.environment || typeof transport.environment !== 'object')) {
    missing.push('transport.environment');
  }

  if (missing.length > 0) throw new InvalidClientPlatformError(missing);
}
