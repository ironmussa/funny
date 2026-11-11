import {
  endpointPath,
  endpointQuery,
  type AnyEndpoint,
  type EndpointInput,
  type ResponseOf,
} from '@funny/shared/contracts/endpoint';
import type { DomainError } from '@funny/shared/errors';
import type { ResultAsync } from 'neverthrow';

import { request } from './_core';

interface CallOptions {
  signal?: AbortSignal;
}

type CallArgs<E extends AnyEndpoint> =
  Record<never, never> extends EndpointInput<E>
    ? [input?: EndpointInput<E>, options?: CallOptions]
    : [input: EndpointInput<E>, options?: CallOptions];

interface RawInput {
  params?: Record<string, string>;
  query?: Record<string, unknown>;
  body?: unknown;
}

/**
 * Call a shared contract endpoint (`@funny/shared/contracts/*`): the URL comes
 * from the endpoint and the response is typed by it. Goes through `request`,
 * so auth, telemetry and the circuit breaker apply as for any other call.
 */
export function callEndpoint<E extends AnyEndpoint>(
  endpoint: E,
  ...[input, options]: CallArgs<E>
): ResultAsync<ResponseOf<E>, DomainError> {
  const { params, query, body } = (input ?? {}) as RawInput;
  return request<ResponseOf<E>>(`${endpointPath(endpoint, params)}${endpointQuery(query)}`, {
    method: endpoint.method,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: options?.signal,
  });
}
