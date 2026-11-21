#!/usr/bin/env bun
/**
 * Enforce a package's aggregate line coverage under `bun test --coverage`.
 * Bun's built-in coverageThreshold fails per file (many files sit at 0%), so
 * this gates on the "All files" line column of the text report instead.
 *
 * Usage (from the package dir, usually through its `test:coverage` script):
 *   bun ../../scripts/coverage-gate.ts --min <pct> [bun test flags…]
 *
 * Runs `bun test --coverage <flags…>` there, streams its output and exits
 * non-zero when a test fails or the line coverage is below `--min`.
 * `COVERAGE_MIN_LINES` overrides `--min`.
 */
import { spawnSync } from 'node:child_process';

import { stripAnsi } from '../packages/shared/src/lib/ansi';

/** The "All files" line coverage (percent) in a `bun test --coverage` text report. */
export function aggregateLineCoverage(output: string): number | null {
  const row = stripAnsi(output)
    .split('\n')
    .find((line) => line.includes('All files') && line.includes('|'));
  if (!row) return null;
  const value = Number.parseFloat(row.split('|').map((part) => part.trim())[2] ?? '');
  return Number.isFinite(value) ? value : null;
}

/** Runs the suite with coverage in `cwd`; resolves to the process exit code. */
export function runCoverageGate(cwd: string, minLines: number, testFlags: string[]): number {
  const result = spawnSync('bun', ['test', '--coverage', ...testFlags], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 256 * 1024 * 1024,
  });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  if (result.status !== 0) return result.status ?? 1;

  const linePct = aggregateLineCoverage(`${result.stdout}\n${result.stderr}`);
  if (linePct === null) {
    console.error('coverage-gate: could not parse coverage summary');
    return 1;
  }
  if (linePct < minLines) {
    console.error(`coverage-gate: line coverage ${linePct}% is below minimum ${minLines}%`);
    return 1;
  }
  console.error(`coverage-gate: line coverage ${linePct}% meets minimum ${minLines}%`);
  return 0;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const at = args.indexOf('--min');
  const fromArgs = at === -1 ? Number.NaN : Number(args[at + 1]);
  const min = Number(process.env.COVERAGE_MIN_LINES ?? fromArgs);
  if (!Number.isFinite(min)) {
    console.error('coverage-gate: pass --min <percent>');
    process.exit(2);
  }
  const flags = at === -1 ? args : [...args.slice(0, at), ...args.slice(at + 2)];
  process.exit(runCoverageGate(process.cwd(), min, flags));
}
