/**
 * @domain subdomain: Runner ↔ Server Communication
 * @domain type: app-service
 * @domain layer: application
 *
 * Device-link enrollment client (runner side).
 *
 * When a runner boots with no credentials and no token/secret, it enrolls
 * itself: it asks the server for a short user code, shows that code to the
 * operator, and polls until a logged-in user approves it in the funny UI. On
 * approval the server returns the runner's credentials (bearer + forwarded-
 * identity secret) — so the operator never hand-carries a token or secret.
 *
 * The start/poll endpoints are public (the runner has no credentials yet), so
 * this module uses a plain fetch rather than the authenticated centralFetch.
 */

import { hostname } from 'os';

import type {
  EnrollStartRequest,
  EnrollStartResponse,
  EnrollPollRequest,
  EnrollPollResponse,
} from '@funny/shared/runner-protocol';

import { log } from '../lib/logger.js';

export interface EnrolledCredentials {
  runnerId: string;
  token: string;
  forwardedSecret: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Print the user code as a prominent operator-facing banner (stdout + log). */
function showUserCode(serverUrl: string, userCode: string): void {
  const banner = [
    '',
    '  ┌──────────────────────────────────────────────────────────┐',
    '  │  Link this runner to your funny account                   │',
    '  │                                                          │',
    `  │   1. Open ${serverUrl.padEnd(46)} │`,
    '  │   2. Go to Settings ▸ Runners ▸ "Link a runner"          │',
    `  │   3. Enter this code:   ${userCode.padEnd(32)} │`,
    '  │                                                          │',
    '  │  Waiting for approval…                                    │',
    '  └──────────────────────────────────────────────────────────┘',
    '',
  ].join('\n');
  // Operator-facing CLI output — must be visible in a terminal and in PaaS logs.
  process.stdout.write(banner + '\n');
  log.info('Runner awaiting device-link approval', {
    namespace: 'runner',
    userCode,
    serverUrl,
  });
}

async function startEnrollment(serverUrl: string): Promise<EnrollStartResponse> {
  const body: EnrollStartRequest = { hostname: hostname(), os: process.platform };
  const res = await fetch(`${serverUrl}/api/runners/enroll/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`enroll/start failed: ${res.status}`);
  }
  return (await res.json()) as EnrollStartResponse;
}

/** Poll once. Returns the parsed response, or null if the enrollment expired (404). */
async function pollOnce(serverUrl: string, pollToken: string): Promise<EnrollPollResponse | null> {
  const body: EnrollPollRequest = { pollToken };
  const res = await fetch(`${serverUrl}/api/runners/enroll/poll`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status === 404) return null; // expired / unknown — restart enrollment
  if (res.status === 429) return { status: 'pending' }; // backoff, treat as pending
  if (!res.ok) throw new Error(`enroll/poll failed: ${res.status}`);
  return (await res.json()) as EnrollPollResponse;
}

/**
 * Run the device-link enrollment loop against `serverUrl`. Blocks until the
 * enrollment is approved, restarting with a fresh code if one expires. Resolves
 * with the delivered credentials.
 */
export async function enrollRunner(serverUrl: string): Promise<EnrolledCredentials> {
  for (;;) {
    let enrollment: EnrollStartResponse;
    try {
      enrollment = await startEnrollment(serverUrl);
    } catch (err) {
      log.warn('enroll/start failed — retrying in 5s', {
        namespace: 'runner',
        error: String(err),
      });
      await sleep(5000);
      continue;
    }

    showUserCode(serverUrl, enrollment.userCode);

    const deadline = Date.now() + enrollment.expiresIn * 1000;
    const intervalMs = Math.max(1, enrollment.interval) * 1000;

    while (Date.now() < deadline) {
      await sleep(intervalMs);
      let result: EnrollPollResponse | null;
      try {
        result = await pollOnce(serverUrl, enrollment.pollToken);
      } catch (err) {
        log.warn('enroll/poll failed — will retry', { namespace: 'runner', error: String(err) });
        continue;
      }
      if (result === null) break; // expired — restart the outer loop with a new code
      if (result.status === 'approved') {
        log.info('Runner enrollment approved', {
          namespace: 'runner',
          runnerId: result.runnerId,
        });
        return {
          runnerId: result.runnerId,
          token: result.token,
          forwardedSecret: result.forwardedSecret,
        };
      }
      // pending — keep polling
    }

    log.info('Enrollment code expired — requesting a new one', { namespace: 'runner' });
  }
}
