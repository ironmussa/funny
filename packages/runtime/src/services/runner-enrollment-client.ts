import { retryAsync, sleep as effectSleep } from '@funny/shared/async';
import { deriveRunnerForwardingKey } from '@funny/shared/auth/runner-keys';
import type { RunnerRegisterResponse } from '@funny/shared/runner-protocol';

import { log } from '../lib/logger.js';
import { resolveRunnerForwardingKey } from '../lib/runner-keys.js';
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
  /**
   * This runner's forwarding key `K_r` (security H1): derived from an
   * operator-supplied root secret, or delivered by the server. Null when the
   * runner has neither (proxied requests then fail closed).
   */
  forwardingKey: string | null;
  /** The owning user (security H7), or null when unknown. */
  ownerUserId: string | null;
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
  sleep: (ms) => effectSleep(ms),
  env: process.env,
};

/** Internal retry signal: registration did not yield a session yet. */
class RegistrationRetry extends Error {
  constructor(readonly reenrolled: boolean) {
    super('Runner registration did not yield a session');
  }
}

/** Owns runner HTTP registration, credential resume, and device-link bootstrap. */
export class RunnerEnrollmentClient {
  private session: RunnerEnrollmentSession | null = null;

  constructor(
    readonly serverUrl: string,
    private readonly advertisement: () => Promise<RunnerAdvertisement>,
    private readonly dependencies: RunnerEnrollmentClientDependencies = defaultDependencies,
  ) {}

  clearSession(): void {
    this.session = null;
  }

  async bootstrap(): Promise<RunnerEnrollmentSession> {
    await this.maybeEnroll();
    return retryAsync(() => this.bootstrapAttempt(), {
      while: (error) => error instanceof RegistrationRetry,
      // Re-enrollment already did its slow work; retry registration immediately.
      delayMs: (retry, error) =>
        (error as RegistrationRetry).reenrolled ? 0 : Math.min(2000 * retry, 15_000),
      onRetry: (error, retry, delayMs) => {
        if ((error as RegistrationRetry).reenrolled) return;
        log.warn(`Registration failed, retrying in ${delayMs / 1000}s (attempt ${retry})`, {
          namespace: 'runner',
        });
      },
      sleep: (ms) => this.dependencies.sleep(ms),
    });
  }

  private async bootstrapAttempt(): Promise<RunnerEnrollmentSession> {
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
      throw new RegistrationRetry(true);
    }
    throw new RegistrationRetry(false);
  }

  private async centralFetch(path: string, options: RequestInit = {}): Promise<Response> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(options.headers as Record<string, string>),
    };
    if (this.session?.token) headers.Authorization = `Bearer ${this.session.token}`;
    // Only an operator-provisioned runner holds the root secret. Enrolled
    // runners authenticate with their bearer; their per-runner key is never
    // accepted by the server as `X-Runner-Auth` (security H1).
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
      const session = this.makeSession({
        runnerId: data.runnerId,
        token: data.token,
        forwardingKey: data.forwardingKey,
        ownerUserId: data.ownerUserId,
      });
      this.session = session;
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
        forwardingKey: data.forwardingKey || undefined,
        ownerUserId: data.ownerUserId || undefined,
      });
      log.info('Registered with central server', {
        namespace: 'runner',
        runnerId: data.runnerId,
        transport: 'grpc-v2',
      });
      return { session: { ...session }, authFailed: false };
    } catch (error) {
      log.error('Failed to connect to central server', { namespace: 'runner', error });
      return { session: null, authFailed: false };
    }
  }

  private async resumeSession(): Promise<RunnerEnrollmentSession | null> {
    const loaded = this.dependencies.loadCredentials(this.serverUrl);
    if (!loaded) return null;
    const credentials = this.migrateLegacyCredentials(loaded);
    this.session = this.makeSession(credentials);
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
    // Security M8: the key stays in module state / the 0600 credentials file —
    // it is never written into process.env, so children cannot inherit it.
    this.dependencies.saveCredentials({
      serverUrl: this.serverUrl,
      runnerId: credentials.runnerId,
      token: credentials.token,
      forwardingKey: credentials.forwardingKey || undefined,
      ownerUserId: credentials.ownerUserId || undefined,
    });
    this.session = this.makeSession(credentials);
  }

  private makeSession(input: {
    runnerId: string;
    token: string;
    forwardingKey?: string | null;
    ownerUserId?: string | null;
  }): RunnerEnrollmentSession {
    return {
      runnerId: input.runnerId,
      token: input.token,
      forwardingKey: resolveRunnerForwardingKey({
        runnerId: input.runnerId,
        rootSecret: this.dependencies.env.RUNNER_AUTH_SECRET,
        forwardingKey: input.forwardingKey,
      }),
      ownerUserId: input.ownerUserId || null,
    };
  }

  /**
   * Pre-H1 enrollments persisted the deployment-wide RUNNER_AUTH_SECRET as
   * `forwardedSecret`. Convert it to this runner's own key and rewrite the
   * file without it, so the root secret no longer sits on disk here.
   */
  private migrateLegacyCredentials(credentials: RunnerCredentials): RunnerCredentials {
    if (!credentials.forwardedSecret) return credentials;
    const { forwardedSecret, ...rest } = credentials;
    const migrated: RunnerCredentials = {
      ...rest,
      forwardingKey:
        rest.forwardingKey || deriveRunnerForwardingKey(forwardedSecret, rest.runnerId),
    };
    this.dependencies.saveCredentials(migrated);
    log.info('Migrated legacy runner credentials to a per-runner forwarding key', {
      namespace: 'runner',
      runnerId: rest.runnerId,
    });
    return migrated;
  }
}
