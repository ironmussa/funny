// Regression test for #479 (part 2/5 of #461): `anti-slop/no-known-value-widening`
// reports nothing in packages/runtime/src. An open `Record<string, X>` or an
// inline object type on a known value is replaced by a named contract (an
// interface, a `Record` over a known key union), a `Map`, or by inference.
//
// It runs the repository's linter (`bun lint`, through scripts/bun-lint.ts),
// which only exists from Bun 1.4.6; on an older Bun (the CI test shards) it
// is skipped, and the CI lint job, on canary, still runs the linter itself.
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// packages/runtime/src/__tests__ → the repository root.
const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

/** True when the running Bun is 1.4.6 or newer. */
function hasBunLint(version = process.versions.bun ?? '0.0.0'): boolean {
  const [major = 0, minor = 0, patch = 0] = version.split(/[.-]/).map(Number);
  return major > 1 || (major === 1 && (minor > 4 || (minor === 4 && patch >= 6)));
}

const HAS_BUN_LINT = hasBunLint();
const RULE = 'anti-slop(no-known-value-widening)';

describe('anti-slop/no-known-value-widening in packages/runtime/src', () => {
  test.skipIf(!HAS_BUN_LINT)(
    'reports no warning',
    () => {
      const run = spawnSync(
        process.execPath,
        ['scripts/bun-lint.ts', '--format', 'agent', 'packages/runtime/src'],
        { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
      );
      const output = `${run.stdout}\n${run.stderr}`;
      // Warnings do not fail the linter; a non-zero exit means it did not run.
      expect(run.status).toBe(0);
      const warnings = output
        .split('\n')
        .filter((line) => line.includes(RULE))
        .map((line) => line.split(': warning')[0]);
      expect(warnings).toEqual([]);
    },
    300_000,
  );
});
