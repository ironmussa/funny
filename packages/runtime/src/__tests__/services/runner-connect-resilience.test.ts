/**
 * Static-analysis regression guards for the runner connect/enrollment wiring.
 *
 * The behavioral pieces are covered elsewhere (runner-enrollment.test.ts drives
 * the enroll loop + credential persistence; runner-enrollment.test.ts on the
 * server covers the enrollment service/routes). These guards pin the glue that
 * is awkward to drive end-to-end but easy to regress:
 *
 *  1. team-client: register() reports auth rejection (401/403) and
 *     registerWithRetry falls back to device-link enrollment instead of looping
 *     on rejected credentials forever.
 *  2. init-runtime: a missing RUNNER_AUTH_SECRET is NOT a fatal error — the
 *     runtime proceeds to initTeamMode (device-link obtains the secret).
 *  3. bin/funny.js: a bare `--team` (no token, no secret) does not abort; it
 *     connects via device-link enrollment.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

import { describe, test, expect } from 'vitest';

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf-8');

describe('runner connect resilience wiring', () => {
  test('register() flags 401/403 as auth failure', () => {
    const src = read('packages/runtime/src/services/team-client.ts');
    expect(src).toMatch(/authFailed:\s*res\.status === 401 \|\| res\.status === 403/);
  });

  test('registerWithRetry falls back to device-link enrollment on auth failure', () => {
    const src = read('packages/runtime/src/services/team-client.ts');
    // The authFailed branch clears the rejected creds and enrolls, rather than
    // retrying the same credentials forever.
    expect(src).toMatch(
      /if \(authFailed\)[\s\S]{0,600}clearRunnerCredentials\(\)[\s\S]{0,200}enrollAndPersist\(\)/,
    );
  });

  test('init-runtime no longer aborts when RUNNER_AUTH_SECRET is unset', () => {
    const src = read('packages/runtime/src/app/init-runtime.ts');
    // The old hard guard must be gone…
    expect(src).not.toMatch(/RUNNER_AUTH_SECRET is required when TEAM_SERVER_URL is set/);
    // …and the runtime must still proceed into team mode (where device-link runs).
    expect(src).toMatch(/initTeamMode/);
  });

  test('CLI bare --team uses device-link enrollment (no abort without secret)', () => {
    const src = read('bin/funny.js');
    expect(src).toMatch(/device-link enrollment/);
    // The classic abort is gated on an invite token being present (classic flow),
    // not on a missing secret alone — so a bare `--team` falls through to enroll.
    expect(src).toMatch(/if \(process\.env\.RUNNER_INVITE_TOKEN\)/);
  });
});
