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
 *  4. bin/funny.js: saved or inherited team credentials do not activate runner
 *     mode, so `bunx @ironmussa/funny` starts local by default even when the
 *     environment contains an old team URL.
 *  5. bin/funny.js: local start is all-in-one (server + loopback runner), while
 *     `--team` starts the runtime as a runner-only process.
 *  6. bin/funny.js: local start opens the browser after the server is listening,
 *     while `--team` keeps runner-only startup terminal-only.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

import { describe, test, expect } from 'vitest';

// Anchor to the repo root from this file's location so the guards work
// regardless of the cwd vitest runs under (root vs. packages/runtime).
const ROOT = join(import.meta.dirname, '../../../../..');
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
    // …and the runtime must still proceed into runner mode (where device-link runs).
    expect(src).toMatch(/initTeamMode/);
  });

  test('CLI bare --team uses device-link enrollment (no abort without secret)', () => {
    const src = read('bin/funny.js');
    expect(src).toMatch(/device-link enrollment/);
    // The classic abort is gated on an invite token being present (classic flow),
    // not on a missing secret alone — so a bare `--team` falls through to enroll.
    expect(src).toMatch(/if \(process\.env\.RUNNER_INVITE_TOKEN\)/);
  });

  test('CLI ignores saved and inherited team config for default local start', () => {
    const src = read('bin/funny.js');
    expect(src).toMatch(/TEAM_ENV_KEYS/);
    expect(src).toMatch(/if \(TEAM_ENV_KEYS\.has\(key\)\) continue/);
    expect(src).toMatch(/if \(!values\.team \|\| values\.local\)/);
    expect(src).toMatch(/delete process\.env\.TEAM_SERVER_URL/);
    expect(src).toMatch(/loadSavedEnv\(\)/);
    expect(src).not.toMatch(/'saved-team'/);
    expect(src).not.toMatch(/from env/);
    expect(src).not.toMatch(/loadSavedEnv\(\);\s*\n\s*\/\/ ── `funny ext`/);
  });

  test('CLI starts team runs in runtime and local runs with a loopback runner', () => {
    const src = read('bin/funny.js');
    expect(src).toMatch(/const isTeamMode = !!values\.team/);
    expect(src).toMatch(/if \(isTeamMode\) \{\s*await startRuntimeInThisProcess\(\)/);
    expect(src).toMatch(/const localServerUrl = `http:\/\/127\.0\.0\.1:\$\{values\.port\}`/);
    expect(src).toMatch(/function ensureLoopbackRunnerOptIn\(\)/);
    expect(src).toMatch(
      /ensureLoopbackRunnerOptIn\(\);\s*\n\s*console\.log\(`\[funny\] Starting from \$\{entry\.label\}/,
    );
    expect(src).toMatch(/TEAM_SERVER_URL: serverUrl/);
    expect(src).toMatch(/FUNNY_LOOPBACK_RUNNER_USERNAME: loopbackRunnerUsername/);
    expect(src).toMatch(/WS_TUNNEL_ONLY: process\.env\.WS_TUNNEL_ONLY \|\| 'true'/);
  });

  test('CLI opens the local server URL after startup unless disabled', () => {
    const src = read('bin/funny.js');
    expect(src).toMatch(/'no-open': \{\s*type: 'boolean'/);
    expect(src).toMatch(/function resolveBrowserUrl\(\)/);
    expect(src).toMatch(/function chromeOpenCommands\(url\)/);
    expect(src).toMatch(/'Google Chrome'/);
    expect(src).toMatch(/google-chrome/);
    expect(src).toMatch(
      /if \(values\['no-open'\] \|\| values\.open === false \|\| process\.env\.CI === 'true'\) return/,
    );
    expect(src).toMatch(/if \(isTeamMode\) \{\s*await startRuntimeInThisProcess\(\)/);
    expect(src).toMatch(/await import\(entry\.path\);\s*\n\s*openBrowser\(resolveBrowserUrl\(\)\)/);
    expect(src).not.toMatch(/startRuntimeInThisProcess\(\);\s*\n\s*openBrowser/);
  });
});
