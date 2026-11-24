import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

// Issue #482 (part 5/5 of #461): these scopes must stay free of
// `anti-slop(no-known-value-widening)` warnings until the rule becomes an error.
// This file lives in packages/workflows/src/__tests__; the regression proof runs
// only tests under packages/.
const ROOT = join(import.meta.dir, '..', '..', '..', '..');
const SCOPES = [
  'scripts',
  'packages/memory',
  'packages/chrome-extension',
  'packages/client-gpuix',
  'packages/workflows',
  'packages/sandbox',
  'packages/gpuix-ui',
  'packages/evflow',
  'packages/client-gpuix-benchmark',
  'packages/client-core',
  'packages/pipelines',
  'packages/api',
];
const RULE = 'anti-slop(no-known-value-widening)';

describe('no-known-value-widening in the #482 scopes', () => {
  test(
    'reports no warning',
    () => {
      const run = Bun.spawnSync(
        [process.execPath, 'scripts/bun-lint.ts', '--format', 'agent', ...SCOPES],
        { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' },
      );
      const output = `${run.stdout.toString()}${run.stderr.toString()}`;
      // Warnings do not fail the linter; a non-zero exit means it did not run.
      expect(run.exitCode).toBe(0);
      const widening = output.split('\n').filter((line) => line.includes(RULE));
      expect(widening).toEqual([]);
    },
    { timeout: 300_000 },
  );
});
