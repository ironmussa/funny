import { createEndpointPolicy, type ClientPlatform } from '@funny/client-core';

function isObject(value: unknown): value is object {
  return value !== null && typeof value === 'object';
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function hasStringMessage(value: unknown): value is { message: string } {
  return isObject(value) && 'message' in value && isString(value.message);
}

export class NativeApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'NativeApiError';
  }
}

export async function nativeJsonRequest<T>(options: {
  platform: ClientPlatform;
  path: string;
  method?: string;
  body?: unknown;
  clientOrigin?: string;
}): Promise<T> {
  const policy = createEndpointPolicy(options.platform.transport.environment);
  const response = await options.platform.transport.request({
    url: `${policy.apiBase}${options.path}`,
    method: options.method ?? 'GET',
    headers: {
      Accept: 'application/json',
      ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : undefined),
      ...(options.clientOrigin ? { Origin: options.clientOrigin } : undefined),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  // Stays undefined when an error response's body is not JSON; read as no body below.
  let decoded: unknown;
  try {
    decoded = text ? JSON.parse(text) : null;
  } catch {
    if (response.ok) throw new NativeApiError(response.status, 'Server returned invalid JSON');
  }
  if (!response.ok) {
    const error = isObject(decoded) ? ('error' in decoded ? decoded.error : undefined) : null;
    const message = isString(error)
      ? error
      : hasStringMessage(error)
        ? error.message
        : `HTTP ${response.status}`;
    throw new NativeApiError(response.status, message);
  }
  // SAFETY: `T` is the response shape the caller declares for this endpoint; like the web
  // client, the native client does not validate response bodies.
  return decoded as T;
}
