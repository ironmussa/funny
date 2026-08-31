import {
  validateRemoteOrigin,
  type ClientHttpRequest,
  type ClientHttpResponse,
  type DiagnosticService,
  type TransportEnvironment,
  type TransportService,
} from '@funny/client-core';

import type { NativeSessionStore } from './session-store';

export interface NativeHeaders {
  get(name: string): string | null;
  getSetCookie?(): string[];
  forEach(callback: (value: string, key: string) => void): void;
}

export interface NativeFetchResponse {
  status: number;
  ok: boolean;
  headers: NativeHeaders;
  text(): Promise<string>;
}

export type NativeFetch = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal: AbortSignal;
  },
) => Promise<NativeFetchResponse>;

const MAX_COOKIE_HEADER_BYTES = 16 * 1024;

function cookiePairs(header: string): Array<[string, string]> {
  return header
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .flatMap((part) => {
      const separator = part.indexOf('=');
      return separator > 0 ? [[part.slice(0, separator), part.slice(separator + 1)]] : [];
    });
}

export class NativeCookieJar {
  private readonly cookies = new Map<string, string>();

  constructor(
    private readonly store: NativeSessionStore,
    private readonly diagnostics: DiagnosticService,
  ) {
    const material = store.load();
    if (material) {
      for (const [name, value] of cookiePairs(material.cookieHeader)) this.cookies.set(name, value);
    }
  }

  header(): string | null {
    if (this.cookies.size === 0) return null;
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  capture(headers: NativeHeaders): void {
    const values =
      headers.getSetCookie?.() ?? ([headers.get('set-cookie')].filter(Boolean) as string[]);
    if (values.length === 0) return;
    for (const value of values) {
      const pair = cookiePairs(value)[0];
      if (!pair) continue;
      const [name, cookieValue] = pair;
      if (/max-age=0/i.test(value) || /expires=thu, 01 jan 1970/i.test(value)) {
        this.cookies.delete(name);
      } else {
        this.cookies.set(name, cookieValue);
      }
    }
    const header = this.header();
    if (!header) return this.store.clear();
    if (Buffer.byteLength(header, 'utf8') > MAX_COOKIE_HEADER_BYTES) {
      this.cookies.clear();
      this.store.clear();
      this.diagnostics.report({
        capability: 'transport',
        operation: 'session.cookie-limit',
        error: new Error('Native session cookie header exceeded its storage limit'),
      });
      return;
    }
    this.store.save({ cookieHeader: header });
  }

  clear(): void {
    this.cookies.clear();
    this.store.clear();
  }
}

function responseHeaders(headers: NativeHeaders): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    result[key] = value;
  });
  return result;
}

export class NativeTransportService implements TransportService {
  readonly environment: TransportEnvironment;
  private readonly serverOrigin: string;

  constructor(options: {
    serverOrigin: string;
    localServerPort: number;
    remoteOriginAllowlist: readonly string[];
    fetch: NativeFetch;
    cookies: NativeCookieJar;
  }) {
    const server = new URL(options.serverOrigin);
    if (
      (server.protocol !== 'http:' && server.protocol !== 'https:') ||
      server.username ||
      server.password
    ) {
      throw new Error('Native server origin must be an HTTP(S) origin without credentials');
    }
    this.serverOrigin = server.origin;
    this.fetch = options.fetch;
    this.cookies = options.cookies;
    this.environment = {
      hostMode: 'native',
      pageOrigin: '',
      localServerPort: options.localServerPort,
      nativeServerOrigin: this.serverOrigin,
      remoteOriginAllowlist: options.remoteOriginAllowlist,
    };
  }

  private readonly fetch: NativeFetch;
  private readonly cookies: NativeCookieJar;
  private readonly activeControllers = new Set<AbortController>();
  private disposed = false;

  async request(request: ClientHttpRequest): Promise<ClientHttpResponse> {
    if (this.disposed) throw new Error('Native transport is disposed');
    const target = new URL(request.url, this.serverOrigin);
    if (
      target.origin !== this.serverOrigin &&
      validateRemoteOrigin(target.origin, this.environment.remoteOriginAllowlist) === null
    ) {
      throw new Error(`Native transport rejected remote origin ${target.origin}`);
    }
    const controller = new AbortController();
    this.activeControllers.add(controller);
    if (request.cancellation?.aborted) controller.abort();
    const unsubscribe = request.cancellation?.subscribe(() => controller.abort());
    const cookie = this.cookies.header();
    try {
      const response = await this.fetch(target.toString(), {
        method: request.method ?? 'GET',
        headers: {
          ...(cookie ? { Cookie: cookie } : {}),
          ...request.headers,
        },
        ...(request.body === undefined ? {} : { body: request.body }),
        signal: controller.signal,
      });
      this.cookies.capture(response.headers);
      return {
        status: response.status,
        ok: response.ok,
        headers: responseHeaders(response.headers),
        text: () => response.text(),
      };
    } finally {
      this.activeControllers.delete(controller);
      unsubscribe?.();
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const controller of this.activeControllers) controller.abort();
    this.activeControllers.clear();
  }
}
