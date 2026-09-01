import type { RunnerRegisterResponse } from '@funny/shared/runner-protocol';

import { log } from '../lib/logger.js';
import {
  clearRunnerCredentials,
  loadRunnerCredentials,
  saveRunnerCredentials,
  type RunnerCredentials,
} from './runner-credentials.js';
import { enrollRunner } from './runner-enrollment.js';

export interface RunnerEnrollmentSession {
  runnerId: string;
  token: string;
}

export interface RunnerAdvertisement {
  name: string;
  hostname: string;
  os: string;
  publicMediaUrl?: string;
  providers: unknown;
  activeBuiltins: string[];
  availableProviders: string[];
}

export interface RunnerEnrollmentClientDependencies {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  enroll(serverUrl: string): ReturnType<typeof enrollRunner>;
  loadCredentials(serverUrl: string): RunnerCredentials | null;
  saveCredentials(credentials: RunnerCredentials): void;
  clearCredentials(): void;
  sleep(ms: number): Promise<void>;
  env: Record<string, string | undefined>;
}

const defaultDependencies: RunnerEnrollmentClientDependencies = {
  fetch: (input, init) => fetch(input, init),
  enroll: enrollRunner,
  loadCredentials: loadRunnerCredentials,
  saveCredentials: saveRunnerCredentials,
  clearCredentials: clearRunnerCredentials,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  env: process.env,
};

/** Owns runner HTTP registration, credential resume, and device-link bootstrap. */
export class RunnerEnrollmentClient {
  private session: RunnerEnrollmentSession | null = null;

  constructor(
    readonly serverUrl: string,
    private readonly advertisement: () => Promise<RunnerAdvertisement>,
    private readonly dependencies: RunnerEnrollmentClientDependencies = defaultDependencies,
  ) {}

  currentSession(): RunnerEnrollmentSession | null {
    return this.session ? { ...this.session } : null;
  }

  clearSession(): void {
    this.session = null;
  }

  async bootstrap(): Promise<RunnerEnrollmentSession> {
    await this.maybeEnroll();
    for (let attempt = 1; ; attempt++) {
      const resumed = await this.resumeSession();
      if (resumed) return resumed;

      const registered = await this.register();
      if (registered.session) return registered.session;

      if (registered.authFailed) {
        log.warn(
          'Server rejected runner credentials (401/403) — falling back to device-link enrollment',
          { namespace: 'runner' },
        );
        this.dependencies.clearCredentials();
        await this.enrollAndPersist();
        continue;
      }

      const delay = Math.min(2000 * attempt, 15_000);
      log.warn(`Registration failed, retrying in ${delay / 1000}s (attempt ${attempt})`, {
        namespace: 'runner',
      });
      await this.dependencies.sleep(delay);
    }
  }

  private async centralFetch(path: string, options: RequestInit = {}): Promise<Response> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(options.headers as Record<string, string>),
    };
    if (this.session?.token) headers.Authorization = `Bearer ${this.session.token}`;
    if (this.dependencies.env.RUNNER_AUTH_SECRET) {
      headers['X-Runner-Auth'] = this.dependencies.env.RUNNER_AUTH_SECRET;
    }
    return this.dependencies.fetch(`${this.serverUrl}${path}`, { ...options, headers });
  }

  private async register(): Promise<{
    session: RunnerEnrollmentSession | null;
    authFailed: boolean;
  }> {
    try {
      const inviteToken = this.dependencies.env.RUNNER_INVITE_TOKEN;
      const res = await this.centralFetch('/api/runners/register', {
        method: 'POST',
        headers: inviteToken ? { 'X-Runner-Invite-Token': inviteToken } : {},
        body: JSON.stringify(await this.advertisement()),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        log.error('Failed to register with central server', {
          namespace: 'runner',
          status: res.status,
          body,
        });
        return { session: null, authFailed: res.status === 401 || res.status === 403 };
      }

      const data = (await res.json()) as RunnerRegisterResponse;
      this.session = { runnerId: data.runnerId, token: data.token };
      try {
        const heartbeat = await this.verifyHeartbeat();
        if (heartbeat === 'missing') {
          this.session = null;
          return { session: null, authFailed: false };
        }
      } catch {
        // Registration heartbeat verification is best-effort. The activated
        // gRPC connection is the authoritative readiness signal.
      }
      this.dependencies.saveCredentials({
        serverUrl: this.serverUrl,
        runnerId: data.runnerId,
        token: data.token,
      });
      log.info('Registered with central server', {
        namespace: 'runner',
        runnerId: data.runnerId,
        transport: 'grpc-v2',
      });
      return {
        session: { runnerId: data.runnerId, token: data.token },
        authFailed: false,
      };
    } catch (error) {
      log.error('Failed to connect to central server', { namespace: 'runner', error });
      return { session: null, authFailed: false };
    }
  }

  private async resumeSession(): Promise<RunnerEnrollmentSession | null> {
    const credentials = this.dependencies.loadCredentials(this.serverUrl);
    if (!credentials) return null;
    this.session = { runnerId: credentials.runnerId, token: credentials.token };
    if (credentials.forwardedSecret && !this.dependencies.env.RUNNER_AUTH_SECRET) {
      this.dependencies.env.RUNNER_AUTH_SECRET = credentials.forwardedSecret;
    }
    try {
      const result = await this.verifyHeartbeat();
      if (result === 'ok') {
        log.info('Resumed runner session from stored credentials', {
          namespace: 'runner',
          runnerId: credentials.runnerId,
        });
        return { ...this.session };
      }
      if (result === 'rejected' || result === 'missing') this.dependencies.clearCredentials();
    } catch (error) {
      log.warn('Session resume failed (network) — falling back to registration', {
        namespace: 'runner',
        error: String(error),
      });
    }
    this.session = null;
    return null;
  }

  private async verifyHeartbeat(): Promise<'ok' | 'rejected' | 'missing' | 'unexpected'> {
    const { providers, activeBuiltins, availableProviders } = await this.advertisement();
    const res = await this.centralFetch('/api/runners/heartbeat', {
      method: 'POST',
      body: JSON.stringify({ activeThreadIds: [], providers, activeBuiltins, availableProviders }),
    });
    if (res.ok) return 'ok';
    if (res.status === 401) return 'rejected';
    if (res.status === 404) return 'missing';
    return 'unexpected';
  }

  private async maybeEnroll(): Promise<void> {
    if (this.dependencies.env.RUNNER_INVITE_TOKEN || this.dependencies.env.RUNNER_AUTH_SECRET)
      return;
    if (this.dependencies.loadCredentials(this.serverUrl)) return;
    log.info('No runner credentials found — starting device-link enrollment', {
      namespace: 'runner',
    });
    await this.enrollAndPersist();
  }

  private async enrollAndPersist(): Promise<void> {
    const credentials = await this.dependencies.enroll(this.serverUrl);
    if (credentials.forwardedSecret) {
      this.dependencies.env.RUNNER_AUTH_SECRET = credentials.forwardedSecret;
    }
    this.dependencies.saveCredentials({
      serverUrl: this.serverUrl,
      runnerId: credentials.runnerId,
      token: credentials.token,
      forwardedSecret: credentials.forwardedSecret || undefined,
    });
    this.session = { runnerId: credentials.runnerId, token: credentials.token };
  }
}
