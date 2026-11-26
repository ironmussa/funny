import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Regression guard for #539: e2e/, scripts/ and spikes/ type their parameters
// (the last `unknown` ones were fulfillTrpc's `data`, mockThreadEvents'
// `events`, analyze-worktree-setup's `ms`, lockfile-changes' sameJson `a` / `b`
// and server-probe's `env`). The rule is a warning in oxlint.config.ts, so
// `bun run lint` alone would not fail on a new one;
// scripts/fitness/check-unknown-parameters.ts runs the vendored rule itself.
// It lives here, next to the packages/client/src guard of the same rule,
// because the factory's regression proof only runs tests under packages/.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const SCRIPT = 'scripts/fitness/check-unknown-parameters.ts';
const LINT_TIMEOUT_MS = 120_000;

describe('anti-slop/no-unknown-parameters outside packages/', () => {
  test(
    'reports no unknown parameter in e2e, scripts and spikes',
    () => {
      const run = spawnSync(process.execPath, [SCRIPT, 'e2e', 'scripts', 'spikes'], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      });
      const findings = `${run.stdout}\n${run.stderr}`
        .split('\n')
        .filter((line) => line.includes(': no-unknown-parameters ('));
      expect(findings).toEqual([]);
      expect(run.status).toBe(0);
    },
    LINT_TIMEOUT_MS,
  );
});
