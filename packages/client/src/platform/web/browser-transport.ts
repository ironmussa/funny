import type {
  ClientHttpResponse,
  DiagnosticService,
  TransportEnvironment,
  TransportService,
} from '@funny/client-core';
import { runAsync } from '@funny/shared/async';

export interface WebEnvironmentInput {
  isTauri: boolean;
  pageOrigin: string;
  serverPort?: string;
  allowedContainerOrigins?: string;
}

export function resolveWebEnvironment(input: WebEnvironmentInput): TransportEnvironment {
  const parsedPort = Number.parseInt(input.serverPort || '3001', 10);
  return {
    hostMode: input.isTauri ? 'tauri' : 'browser',
    pageOrigin: input.pageOrigin,
    localServerPort: Number.isFinite(parsedPort) ? parsedPort : 3001,
    remoteOriginAllowlist:
      input.allowedContainerOrigins
        ?.split(',')
        .map((origin) => origin.trim())
        .filter(Boolean) ?? [],
  };
}

export function createBrowserTransportService(
  environment: TransportEnvironment,
  fetchImplementation: typeof fetch,
  diagnostics: DiagnosticService,
  lifetimeSignal?: () => AbortSignal,
): TransportService {
  return {
    environment,
    async request(request) {
      const controller = new AbortController();
      const lifetime = lifetimeSignal?.();
      const abort = () => controller.abort();
      lifetime?.addEventListener('abort', abort, { once: true });
      if (lifetime?.aborted) controller.abort();
      const stopCancellation = request.cancellation?.subscribe(() => controller.abort());
      if (request.cancellation?.aborted) controller.abort();
      try {
        const response = await runAsync(
          () =>
            fetchImplementation(request.url, {
              method: request.method,
              headers: request.headers,
              body: request.body,
              credentials: 'include',
              signal: controller.signal,
            }),
          { signal: controller.signal },
        );
        const headers: Record<string, string> = {};
        response.headers.forEach((value, key) => {
          headers[key] = value;
        });
        return {
          status: response.status,
          ok: response.ok,
          headers,
          text: () => response.text(),
        } satisfies ClientHttpResponse;
      } catch (error) {
        // An aborted request is an expected control-flow outcome when an effect
        // is cleaned up or a newer request supersedes an older one. Reporting
        // it as a platform failure floods the console during React StrictMode
        // startup and makes genuine transport failures harder to spot.
        if (controller.signal.aborted) throw new DOMException('Request aborted', 'AbortError');
        diagnostics.report({ capability: 'transport', operation: 'request', error });
        throw error;
      } finally {
        stopCancellation?.();
        lifetime?.removeEventListener('abort', abort);
      }
    },
  };
}
