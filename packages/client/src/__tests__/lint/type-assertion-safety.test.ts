import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Regression guard for #448: every type assertion in the client's production
// code is either gone or carries a `SAFETY:` comment stating its invariant.
// The rule is still a warning in oxlint.config.ts (#447 turns it into an error),
// so `bun run lint` alone would not fail on a new unjustified assertion.

const RULE = 'require-safety-comment-for-type-assertion';
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');

/** `bun lint` exists from Bun 1.4.6 on (see scripts/bun-lint.ts). */
function bunHasLint(version: string): boolean {
  const [major = 0, minor = 0, patch = 0] = version
    .split(/[.+-]/)
    .slice(0, 3)
    .map((part) => Number.parseInt(part, 10) || 0);
  if (major !== 1) return major > 1;
  if (minor !== 4) return minor > 4;
  return patch >= 6;
}

test.skipIf(!bunHasLint(process.versions.bun ?? '0.0.0'))(
  'client production code has no type assertion without a SAFETY comment',
  () => {
    const run = spawnSync(
      process.execPath,
      ['lint', '--no-script', '--disable-nested-config', '--format', 'agent', 'packages/client'],
      { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    );
    const output = `${run.stdout}\n${run.stderr}`;
    const unjustified = output.split('\n').filter((line: string) => line.includes(RULE));

    expect(unjustified).toEqual([]);
  },
  60_000,
);
