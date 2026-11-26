import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Regression guard for #537: packages/pipelines/src types its parameters (caught
// values are named `cause`, the other inputs have named types). The rule is
// still a warning in oxlint.config.ts, so `bun run lint` alone would not fail
// on a new one. scripts/fitness/check-unknown-parameters.ts runs the vendored
// rule itself, so this needs no `bun lint` (Bun canary only).
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const SCRIPT = 'scripts/fitness/check-unknown-parameters.ts';
const LINT_TIMEOUT_MS = 120_000;

describe('anti-slop/no-unknown-parameters in packages/pipelines/src', () => {
  test(
    'reports no unknown parameter',
    () => {
      const run = spawnSync(process.execPath, [SCRIPT, 'packages/pipelines/src'], {
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
