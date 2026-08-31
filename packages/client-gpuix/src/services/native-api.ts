import { createEndpointPolicy, type ClientPlatform } from '@funny/client-core';

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
      ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(options.clientOrigin ? { Origin: options.clientOrigin } : {}),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const text = await response.text();
  let decoded: unknown = null;
  if (text) {
    try {
      decoded = JSON.parse(text);
    } catch {
      if (response.ok) throw new NativeApiError(response.status, 'Server returned invalid JSON');
    }
  }
  if (!response.ok) {
    const error =
      decoded && typeof decoded === 'object' ? (decoded as { error?: unknown }).error : null;
    const message =
      typeof error === 'string'
        ? error
        : error &&
            typeof error === 'object' &&
            typeof (error as { message?: unknown }).message === 'string'
          ? String((error as { message: string }).message)
          : `HTTP ${response.status}`;
    throw new NativeApiError(response.status, message);
  }
  return decoded as T;
}
