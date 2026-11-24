import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

// Issue #453 cleared shadcn/no-restyle in these client directories. What is left
// are one-off looks that need a design decision (listed in the pull request);
// this budget keeps restyles from creeping back until #447 makes the rule an error.
// Lower a number when you fix one of them; never raise it.
const BUDGET: Record<string, number> = {
  sidebar: 3,
  thread: 23,
  'tool-cards': 23,
  settings: 3,
};

const ROOT = join(import.meta.dir, '..', '..');

/** Number of shadcn/no-restyle warnings `bun lint` reports under a client components directory. */
function countRestyles(dir: string): number {
  const run = Bun.spawnSync(
    [
      process.execPath,
      join(ROOT, 'scripts', 'bun-lint.ts'),
      '--format',
      'agent',
      join('packages', 'client', 'src', 'components', dir),
    ],
    { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' },
  );
  const out = `${run.stdout.toString()}${run.stderr.toString()}`;
  // Warnings exit 0; anything else means the linter did not run, and a count of 0 would lie.
  if (run.exitCode !== 0) throw new Error(`bun lint failed on ${dir}:\n${out.slice(0, 2000)}`);
  return out.split('\n').filter((line) => line.includes('shadcn(no-restyle)')).length;
}

describe('shadcn/no-restyle budget (#453)', () => {
  test.each(Object.entries(BUDGET))(
    'components/%s stays within %i warnings',
    (dir, budget) => {
      expect(countRestyles(dir)).toBeLessThanOrEqual(budget);
    },
    60_000,
  );
});
