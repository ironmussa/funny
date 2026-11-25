import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

// Issue #457 cleared anti-slop/no-unsafe-dictionary-type everywhere except
// packages/server and packages/runtime (their own #447 issues). What is left
// needs a change in server or runtime callers first (listed in the pull
// request); this budget keeps open dictionaries from creeping back until #447
// makes the rule an error. Lower a number when you fix one of them; never raise
// it, and do not add a file.
const BUDGET: Record<string, number> = {
  'packages/shared/src/runner-protocol.ts': 10,
  'packages/core/src/debug.ts': 3,
  'packages/core/src/agents/types.ts': 1,
  'packages/pipelines/src/yaml/interpolate.ts': 1,
  'packages/workflows/src/compiler/yaml-compiler.ts': 2,
  'packages/workflows/src/compiler/action-provider.ts': 1,
};

const OUT_OF_SCOPE = ['packages/server/', 'packages/runtime/'];

const ROOT = join(import.meta.dir, '..', '..');

/** no-unsafe-dictionary-type warnings per file, outside server and runtime. */
function countByFile(): Record<string, number> {
  const run = Bun.spawnSync(
    [process.execPath, join(ROOT, 'scripts', 'bun-lint.ts'), '--format', 'agent', '.'],
    { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' },
  );
  const out = `${run.stdout.toString()}${run.stderr.toString()}`;
  // Warnings exit 0, and an error of another rule exits 1 with its diagnostics.
  // A non-zero exit with no diagnostic means the linter did not run, and a
  // count of 0 would lie.
  const linted = /^\S+:\d+:\d+: (warning|error) /m.test(out);
  if (run.exitCode !== 0 && !linted) throw new Error(`bun lint failed:\n${out.slice(0, 2000)}`);
  const counts: Record<string, number> = {};
  for (const line of out.split('\n')) {
    if (!line.includes('anti-slop(no-unsafe-dictionary-type)')) continue;
    const file = line.slice(0, line.indexOf(':'));
    if (OUT_OF_SCOPE.some((prefix) => file.startsWith(prefix))) continue;
    counts[file] = (counts[file] ?? 0) + 1;
  }
  return counts;
}

describe('anti-slop/no-unsafe-dictionary-type budget (#457)', () => {
  test('no file outside server and runtime goes over its listed exceptions', () => {
    const over = Object.entries(countByFile())
      .filter(([file, count]) => count > (BUDGET[file] ?? 0))
      .map(([file, count]) => `${file}: ${count} (budget ${BUDGET[file] ?? 0})`);
    expect(over).toEqual([]);
  }, 120_000);
});
