import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseTaskProgress } from '@funny/shared/task-progress';
import { afterEach, beforeEach, expect, test } from 'vitest';

import type { CheckPlan } from '../../../services/checks/toolchain.js';

const CLI = join(__dirname, '../../../services/checks/run-cli.ts');
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'funny-run-cli-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test('a background run prints only the summary and exits with the check code', () => {
  const plan: CheckPlan = {
    kind: 'typecheck',
    cwd: dir,
    progress: 'task',
    notes: [],
    steps: [
      {
        name: 'tsc',
        command: "echo 'src/a.ts(3,5): error TS2322: nope'; echo noise; exit 2",
        tool: 'tsc',
      },
    ],
  };
  const progressPath = join(dir, 'progress.json');
  const spec = join(dir, 'spec.json');
  writeFileSync(spec, JSON.stringify({ plan, progressPath }));

  const run = spawnSync('bun', [CLI, spec], { encoding: 'utf8' });

  expect(run.status).toBe(2);
  expect(run.stdout).toContain('typecheck FAILED (exit 2');
  expect(run.stdout).toContain('error src/a.ts:3:5 TS2322: nope');
  // The step's own output stays out: only the summary is printed.
  expect(run.stdout.split('\n')).not.toContain('noise');
  expect(run.stdout).not.toContain('[data-dir]');
  expect(run.stdout.trimEnd().endsWith(`progressPath: ${progressPath}`)).toBe(true);
  const progress = parseTaskProgress(readFileSync(progressPath, 'utf8'));
  expect(progress.ok && progress.value.status).toBe('failed');
});

test('a bad spec exits 2 without running anything', () => {
  const spec = join(dir, 'spec.json');
  writeFileSync(spec, '{"plan": 1}');
  expect(spawnSync('bun', [CLI, spec], { encoding: 'utf8' }).status).toBe(2);
});
