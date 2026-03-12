/**
 * HTTP client for communicating with the Central funny server.
 * Handles registration, heartbeat, task polling, and result reporting.
 */

import type {
  RunnerRegisterRequest,
  RunnerRegisterResponse,
  RunnerHeartbeatRequest,
  RunnerHeartbeatResponse,
  RunnerTaskResultRequest,
  RunnerGitResponse,
  PendingTasksResponse,
  RunnerGitRequest,
} from '@funny/shared/runner-protocol';

export interface CentralClientOptions {
  /** Base URL of the central server (e.g. "http://192.168.1.10:3001") */
  serverUrl: string;
  /** Runner auth token (received after registration) */
  token?: string;
}

export class CentralClient {
  private serverUrl: string;
  private token: string | null;

  constructor(opts: CentralClientOptions) {
    this.serverUrl = opts.serverUrl.replace(/\/$/, '');
    this.token = opts.token ?? null;
  }

  setToken(token: string): void {
    this.token = token;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.serverUrl}/api/runners${path}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }

    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Central server error ${res.status}: ${text}`);
    }

    return res.json() as Promise<T>;
  }

  // ── Registration ──────────────────────────────────────

  async register(req: RunnerRegisterRequest): Promise<RunnerRegisterResponse> {
    const res = await this.request<RunnerRegisterResponse>('POST', '/register', req);
    this.token = res.token;
    return res;
  }

  // ── Heartbeat ─────────────────────────────────────────

  async heartbeat(req: RunnerHeartbeatRequest): Promise<RunnerHeartbeatResponse> {
    return this.request<RunnerHeartbeatResponse>('POST', '/heartbeat', req);
  }

  // ── Task Polling ──────────────────────────────────────

  async pollTasks(): Promise<PendingTasksResponse> {
    return this.request<PendingTasksResponse>('GET', '/tasks');
  }

  // ── Task Result ───────────────────────────────────────

  async reportTaskResult(req: RunnerTaskResultRequest): Promise<void> {
    await this.request<{ ok: boolean }>('POST', '/tasks/result', req);
  }

  // ── Git Operations (direct proxy) ────────────────────

  async gitOperation(req: RunnerGitRequest): Promise<RunnerGitResponse> {
    return this.request<RunnerGitResponse>('POST', '/git', req);
  }
}
