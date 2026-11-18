#!/usr/bin/env bun
/**
 * Enforce aggregate line coverage for packages/server.
 * Bun's built-in coverageThreshold fails per-file (many routes at 0%),
 * so CI uses this script to gate on the "All files" line column instead.
 *
 * Files excluded from coverage (see bunfig.toml):
 *   - src/routes/pipelines.ts (scheduler approval/progress pending)
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { stripAnsi } from '@funny/shared/lib/ansi';

const MIN_LINE_COVERAGE = Number(process.env.SERVER_COVERAGE_MIN_LINES ?? 65);
const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const result = spawnSync('bun', ['test', '--coverage', '--isolate', '--timeout', '20000'], {
  cwd: pkgRoot,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
});

const output = `${result.stdout}\n${result.stderr}`;
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

const stripped = stripAnsi(output);
const line = stripped.split('\n').find((row) => row.includes('All files') && row.includes('|'));

if (!line) {
  console.error('coverage-gate: could not parse coverage summary');
  process.exit(1);
}

const columns = line.split('|').map((part) => part.trim());
const linePct = Number.parseFloat(columns[2] ?? '');

if (!Number.isFinite(linePct)) {
  console.error(`coverage-gate: invalid line coverage value: ${columns[2]}`);
  process.exit(1);
}

if (linePct < MIN_LINE_COVERAGE) {
  console.error(`coverage-gate: line coverage ${linePct}% is below minimum ${MIN_LINE_COVERAGE}%`);
  process.exit(1);
}

console.error(`coverage-gate: line coverage ${linePct}% meets minimum ${MIN_LINE_COVERAGE}%`);
