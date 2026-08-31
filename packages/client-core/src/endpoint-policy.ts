import type { TransportEnvironment } from './platform';

interface ParsedUrl {
  protocol: string;
  username: string;
  password: string;
  origin: string;
}

declare const URL: {
  new (input: string): ParsedUrl;
};

export interface EndpointPolicy {
  apiBase: string;
  realtimeOrigin: string;
  remoteOriginAllowlist: readonly string[];
}

export function createEndpointPolicy(environment: TransportEnvironment): EndpointPolicy {
  const localOrigin = `http://localhost:${environment.localServerPort}`;
  const primaryOrigin =
    environment.hostMode === 'native'
      ? (environment.nativeServerOrigin ?? localOrigin)
      : environment.hostMode === 'tauri'
        ? localOrigin
        : environment.pageOrigin;
  return {
    apiBase: environment.hostMode === 'browser' ? '/api' : `${primaryOrigin}/api`,
    realtimeOrigin: primaryOrigin,
    remoteOriginAllowlist: environment.remoteOriginAllowlist,
  };
}

export function validateRemoteOrigin(raw: unknown, allowlist: readonly string[]): string | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  let parsed: ParsedUrl;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (parsed.username || parsed.password) return null;
  if (allowlist.length > 0 && !allowlist.includes(parsed.origin)) return null;
  return parsed.origin;
}

export function resolveApiBaseForThread(
  policy: EndpointPolicy,
  thread?: { runtime?: string; containerUrl?: string },
): string {
  if (thread?.runtime === 'remote' && thread.containerUrl) {
    const origin = validateRemoteOrigin(thread.containerUrl, policy.remoteOriginAllowlist);
    if (origin) return `${origin}/api`;
  }
  return policy.apiBase;
}
