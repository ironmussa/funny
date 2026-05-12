/**
 * @domain subdomain: Orchestration
 * @domain subdomain-type: core
 * @domain type: adapter
 * @domain layer: infrastructure
 *
 * Shared `fetch` wrapper for the orchestrator brain → funny server
 * (`/api/orchestrator/system/*`). Adds the `X-Orchestrator-Auth` header
 * automatically and surfaces non-2xx responses as thrown errors so
 * adapter callers can wrap them with `Result.fromThrowable` per the
 * neverthrow boundary mandate.
 */

export interface HttpClientOptions {
  /** Funny server URL, e.g. `http://localhost:3001`. */
  baseUrl: string;
  /** Shared secret matching `ORCHESTRATOR_AUTH_SECRET` on the server. */
  authSecret: string;
  /**
   * Test seam — defaults to global `fetch`. Standalone deploys typically
   * override this with an `undici` pool to bound concurrent requests.
   */
  fetch?: typeof fetch;
}

export class HttpClientError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly body: string | null,
  ) {
    super(message);
    this.name = 'HttpClientError';
  }
}

export class HttpOrchestratorClient {
  private readonly baseUrl: string;
  private readonly authSecret: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: HttpClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.authSecret = opts.authSecret;
    this.fetchImpl = opts.fetch ?? fetch;
  }

  /**
   * Issue a request. `path` is relative to `/api/orchestrator/system`,
   * e.g. `/runs` becomes `<baseUrl>/api/orchestrator/system/runs`.
   */
  async request<T = unknown>(
    method: string,
    path: string,
    opts: {
      query?: Record<string, string | number | undefined>;
      body?: unknown;
      signal?: AbortSignal;
    } = {},
  ): Promise<T> {
    const url = new URL(this.baseUrl + '/api/orchestrator/system' + path);
    if (opts.query) {
      for (const [k, v] of Object.entries(opts.query)) {
        if (v !== undefined) url.searchParams.set(k, String(v));
      }
    }

    const headers: Record<string, string> = {
      'X-Orchestrator-Auth': this.authSecret,
      Accept: 'application/json',
    };
    let body: string | null = null;
    if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(opts.body);
    }

    const response = await this.fetchImpl(url.toString(), {
      method,
      headers,
      body,
      signal: opts.signal,
    });

    if (response.status === 204) {
      return undefined as T;
    }

    const text = await response.text();
    if (!response.ok) {
      throw new HttpClientError(
        response.status,
        `HTTP ${response.status} ${method} ${path}`,
        text || null,
      );
    }
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new HttpClientError(response.status, 'Invalid JSON response', text);
    }
  }

  get<T = unknown>(path: string, query?: Record<string, string | number | undefined>): Promise<T> {
    return this.request<T>('GET', path, { query });
  }

  post<T = unknown>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('POST', path, { body });
  }

  patch<T = unknown>(path: string, body: unknown): Promise<T> {
    return this.request<T>('PATCH', path, { body });
  }

  del<T = unknown>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('DELETE', path, { body });
  }
}
