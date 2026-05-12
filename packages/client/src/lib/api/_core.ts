import type { DomainError } from '@funny/shared/errors';
import { internal, processError } from '@funny/shared/errors';
import { ResultAsync } from 'neverthrow';

import i18n from '@/i18n/config';
import { emitUnauthorized } from '@/lib/api/auth-events';
import { startSpan, metric } from '@/lib/telemetry';
import { useCircuitBreakerStore } from '@/stores/circuit-breaker-store';

// ─── Git pull strategy (matches `PullStrategy` in @funny/core/git/remote.ts) ──
export type PullStrategy = 'ff-only' | 'merge' | 'rebase';

const isTauri = !!(window as any).__TAURI_INTERNALS__;
const serverPort = import.meta.env.VITE_SERVER_PORT || '3001';
// In the browser, always use relative URLs so requests go through the Vite proxy
// (which forwards to VITE_SERVER_URL). This keeps cookies same-origin.
// Only Tauri needs an absolute URL since there's no dev proxy.
export const BASE = isTauri ? `http://localhost:${serverPort}/api` : '/api';

const allowedContainerOrigins: string[] =
  (import.meta.env.VITE_ALLOWED_CONTAINER_ORIGINS as string | undefined)
    ?.split(',')
    .flatMap((s) => {
      const trimmed = s.trim();
      return trimmed ? [trimmed] : [];
    }) ?? [];

export function validateContainerUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (parsed.username || parsed.password) return null;
  if (allowedContainerOrigins.length > 0 && !allowedContainerOrigins.includes(parsed.origin)) {
    return null;
  }
  return parsed.origin;
}

export function getBaseUrlForThread(thread?: { runtime?: string; containerUrl?: string }): string {
  if (thread?.runtime === 'remote' && thread.containerUrl) {
    const safe = validateContainerUrl(thread.containerUrl);
    if (safe) return `${safe}/api`;
  }
  return BASE;
}

export function request<T>(path: string, init?: RequestInit): ResultAsync<T, DomainError> {
  return ResultAsync.fromPromise(
    (async () => {
      const cb = useCircuitBreakerStore.getState();
      const method = init?.method || 'GET';
      const span = startSpan('http.client', {
        attributes: { 'http.method': method, 'http.url': path },
      });
      const t0 = performance.now();

      if (cb.state === 'open') {
        span.end('ERROR');
        const err = internal('Server unavailable (circuit open)');
        err.friendlyMessage = i18n.t('errors.networkError', {
          defaultValue: 'Unable to reach the server. Check your connection and try again.',
        });
        throw err;
      }

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        traceparent: span.traceparent,
      };
      if (init?.headers) {
        Object.assign(headers, init.headers);
      }

      let res: Response;
      try {
        res = await fetch(`${BASE}${path}`, {
          ...init,
          headers,
          credentials: 'include',
        });
      } catch (networkError) {
        if (networkError instanceof DOMException && networkError.name === 'AbortError') {
          span.end('ERROR');
          throw internal('Request aborted');
        }
        useCircuitBreakerStore.getState().recordFailure();
        span.end('ERROR');
        metric('http.client.duration', performance.now() - t0, {
          type: 'gauge',
          attributes: { method, path, status: '0' },
        });
        const err = internal(String(networkError));
        err.friendlyMessage = i18n.t('errors.networkError', {
          defaultValue: 'Unable to reach the server. Check your connection and try again.',
        });
        throw err;
      }

      const durationMs = performance.now() - t0;
      metric('http.client.duration', durationMs, {
        type: 'gauge',
        attributes: { method, path, status: String(res.status) },
      });

      if (!res.ok) {
        span.end('ERROR');

        // On 401, fire an event for auth-store to verify and log out if needed.
        // Decoupled via auth-events so _core doesn't depend on auth-store/auth-client.
        if (res.status === 401) {
          const pathNoQuery = path.split('?')[0];
          const isInitialProfileLoad = method === 'GET' && pathNoQuery === '/profile';
          if (!isInitialProfileLoad) {
            emitUnauthorized(pathNoQuery);
          }
        }

        // 5xx errors trigger the circuit breaker; 4xx do NOT.
        // 502 is excluded — it means the runner (proxy target) is unreachable,
        // not the server itself. Tripping the breaker on 502 would block
        // server-local requests (profile, threads, etc.) that still work fine.
        if (res.status >= 500 && res.status !== 502) {
          useCircuitBreakerStore.getState().recordFailure();
        }

        const body = await res.json().catch(() => ({}));
        const rawError = body.error;
        const message =
          typeof rawError === 'string' && rawError.length > 0
            ? rawError
            : rawError
              ? JSON.stringify(rawError)
              : `HTTP ${res.status}`;
        if (body.stderr || body.exitCode != null) {
          throw processError(message, body.exitCode, body.stderr);
        }

        const STATUS_TYPE: Record<number, DomainError['type']> = {
          404: 'NOT_FOUND',
          403: 'FORBIDDEN',
          409: 'CONFLICT',
        };
        const type: DomainError['type'] =
          STATUS_TYPE[res.status] ?? (res.status >= 500 ? 'INTERNAL' : 'BAD_REQUEST');
        throw { type, message } as DomainError;
      }

      span.end('OK');
      useCircuitBreakerStore.getState().recordSuccess();

      return res.json() as Promise<T>;
    })(),
    (error): DomainError => {
      if (typeof error === 'object' && error !== null && 'type' in error) {
        return error as DomainError;
      }
      return internal(String(error));
    },
  );
}
