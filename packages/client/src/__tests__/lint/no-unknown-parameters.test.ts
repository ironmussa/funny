import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Regression guard for #525: packages/client/src types its parameters (the
// last `unknown` one was `applyQueuedCount`'s `responseQueuedCount`, now read
// from the typed send response). The rule is still a warning in
// oxlint.config.ts (#447 turns it into an error), so `bun run lint` alone would
// not fail on a new one. scripts/fitness/check-unknown-parameters.ts runs the
// vendored rule itself, so this needs no `bun lint` (Bun canary only).
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const SCRIPT = 'scripts/fitness/check-unknown-parameters.ts';
// The check parses every source file of the package; under the parallel suite
// that can take longer than the default per-test timeout.
const LINT_TIMEOUT_MS = 120_000;

function runCheck(args: string[]) {
  const run = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return { status: run.status, output: `${run.stdout}\n${run.stderr}` };
}

describe('anti-slop/no-unknown-parameters in packages/client/src', () => {
  test('the check reports an unknown parameter and skips the allowed ones', () => {
    const run = runCheck(['--self-test']);
    expect(run.output).toContain('fixtures ok');
    expect(run.status).toBe(0);
  });

  test(
    'reports no unknown parameter',
    () => {
      const run = runCheck(['packages/client/src']);
      const findings = run.output
        .split('\n')
        .filter((line) => line.includes(': no-unknown-parameters ('));
      expect(findings).toEqual([]);
      expect(run.status).toBe(0);
    },
    LINT_TIMEOUT_MS,
  );
});
