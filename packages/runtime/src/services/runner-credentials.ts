/**
 * @domain subdomain: Runner Coordination
 * @domain type: domain-service
 * @domain layer: infrastructure
 *
 * Persisted runner credentials.
 *
 * The runner invite token is single-use: the server consumes it on first
 * registration. The bearer token the server returns used to live only in
 * memory, so every runner restart demanded a fresh invite token from the
 * UI. Persisting the bearer to disk (mode 0600, like `auth-secret` and
 * `encryption.key`) makes restarts transparent: the runner resumes its
 * session and only falls back to the invite flow when the server rejects
 * the stored token (e.g. the runner was deleted from the UI).
 *
 * The runner has no database by design — all persistence proxies to the
 * server — and fetching "my token" from the server would require the very
 * token being recovered, so a local file is the correct mechanism.
 */
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';

import { DATA_DIR } from '../lib/data-dir.js';
import { log } from '../lib/logger.js';

const CREDENTIALS_FILE = 'runner-credentials.json';

export interface RunnerCredentials {
  /** Server these credentials belong to — never reuse across servers. */
  serverUrl: string;
  runnerId: string;
  token: string;
  /**
   * Shared forwarded-identity secret (RUNNER_AUTH_SECRET) delivered during
   * device-link enrollment. Persisted so a restart can re-load it into the
   * environment and proxied requests keep verifying — without the operator
   * ever hand-carrying the secret. Absent for runners configured the classic
   * way (explicit --secret / env), which already have it in the environment.
   */
  forwardedSecret?: string;
}

function credentialsPath(dir: string): string {
  return join(dir, CREDENTIALS_FILE);
}

/**
 * Load persisted credentials for the given server.
 * Returns null when the file is missing, unreadable, malformed, or belongs
 * to a different server URL.
 */
export function loadRunnerCredentials(
  serverUrl: string,
  dir: string = DATA_DIR,
): RunnerCredentials | null {
  const path = credentialsPath(dir);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<RunnerCredentials>;
    if (
      typeof parsed.serverUrl !== 'string' ||
      typeof parsed.runnerId !== 'string' ||
      typeof parsed.token !== 'string' ||
      parsed.token.length === 0
    ) {
      return null;
    }
    if (parsed.serverUrl !== serverUrl) {
      log.info('Stored runner credentials belong to a different server — ignoring', {
        namespace: 'runner',
        storedServer: parsed.serverUrl,
      });
      return null;
    }
    return {
      serverUrl: parsed.serverUrl,
      runnerId: parsed.runnerId,
      token: parsed.token,
      forwardedSecret:
        typeof parsed.forwardedSecret === 'string' && parsed.forwardedSecret.length > 0
          ? parsed.forwardedSecret
          : undefined,
    };
  } catch (err) {
    log.warn('Failed to read stored runner credentials', {
      namespace: 'runner',
      error: String(err),
    });
    return null;
  }
}

/** Persist credentials after a successful registration (file mode 0600). */
export function saveRunnerCredentials(creds: RunnerCredentials, dir: string = DATA_DIR): void {
  try {
    writeFileSync(credentialsPath(dir), JSON.stringify(creds, null, 2), { mode: 0o600 });
  } catch (err) {
    // Non-fatal: the runner still works this session; the next restart
    // will need a fresh invite token.
    log.warn('Failed to persist runner credentials', {
      namespace: 'runner',
      error: String(err),
    });
  }
}

/** Remove stored credentials (server rejected them or runner was purged). */
export function clearRunnerCredentials(dir: string = DATA_DIR): void {
  try {
    const path = credentialsPath(dir);
    if (existsSync(path)) unlinkSync(path);
  } catch (err) {
    log.warn('Failed to clear runner credentials', { namespace: 'runner', error: String(err) });
  }
}
