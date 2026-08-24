import {
  createApiClient,
  createEndpointPolicy,
  resolveApiBaseForThread,
  validateRemoteOrigin,
  type ApiClientError,
  type ClientCancellation,
} from '@funny/client-core';
import type { DomainError } from '@funny/shared/errors';
import { ResultAsync } from 'neverthrow';

import i18n from '@/i18n/config';
import { emitUnauthorized } from '@/lib/api/auth-events';
import { metric, startSpan } from '@/lib/telemetry';
import { clientComposition } from '@/platform/client-composition';
import { useCircuitBreakerStore } from '@/stores/circuit-breaker-store';

// ─── Git pull strategy (matches `PullStrategy` in @funny/core/git/remote.ts) ──
export type PullStrategy = 'ff-only' | 'merge' | 'rebase';

const endpointPolicy = createEndpointPolicy(clientComposition.platform.transport.environment);
export const BASE = endpointPolicy.apiBase;

export function validateContainerUrl(raw: unknown): string | null {
  return validateRemoteOrigin(raw, endpointPolicy.remoteOriginAllowlist);
}

export function getBaseUrlForThread(thread?: { runtime?: string; containerUrl?: string }): string {
  return resolveApiBaseForThread(endpointPolicy, thread);
}

const apiClient = createApiClient({
  transport: clientComposition.platform.transport,
  endpointPolicy,
  clock: () => performance.now(),
  telemetry: { startSpan, metric },
  circuitBreaker: {
    snapshot: () => useCircuitBreakerStore.getState(),
    recordFailure: () => useCircuitBreakerStore.getState().recordFailure(),
    recordSuccess: () => useCircuitBreakerStore.getState().recordSuccess(),
  },
  onUnauthorized: emitUnauthorized,
  networkFriendlyMessage: () =>
    i18n.t('errors.networkError', {
      defaultValue: 'Unable to reach the server. Check your connection and try again.',
    }),
});

function cancellationFromSignal(
  signal: AbortSignal | null | undefined,
): ClientCancellation | undefined {
  if (!signal) return undefined;
  return {
    get aborted() {
      return signal.aborted;
    },
    subscribe(listener) {
      signal.addEventListener('abort', listener, { once: true });
      return () => signal.removeEventListener('abort', listener);
    },
  };
}

function headersFromInit(headers: HeadersInit | undefined): Record<string, string> | undefined {
  if (!headers) return undefined;
  const result: Record<string, string> = {};
  new Headers(headers).forEach((value, key) => {
    result[key] = value;
  });
  return result;
}

export function request<T>(path: string, init?: RequestInit): ResultAsync<T, DomainError> {
  const promise = apiClient.request<T>(path, {
    method: init?.method,
    headers: headersFromInit(init?.headers),
    body: typeof init?.body === 'string' ? init.body : undefined,
    cancellation: cancellationFromSignal(init?.signal),
  });
  return ResultAsync.fromPromise(promise, (error) => error as ApiClientError as DomainError);
}
