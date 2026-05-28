#!/usr/bin/env bun
/**
 * Enforce aggregate line coverage for packages/server.
 * Bun's built-in coverageThreshold fails per-file (many routes at 0%),
 * so CI uses this script to gate on the "All files" line column instead.
 *
 * Files excluded from coverage (see bunfig.toml):
 *   - src/routes/designs.ts, agent-templates.ts
 *   - src/routes/pipelines.ts (orchestrator approval/progress pending)
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MIN_LINE_COVERAGE = Number(process.env.SERVER_COVERAGE_MIN_LINES ?? 60);
const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const result = spawnSync('bun', ['test', '--coverage'], {
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

/** Strip ANSI SGR sequences from Bun coverage output (char 0x1b + "[…m"). */
function stripAnsi(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 0x1b && text[i + 1] === '[') {
      i += 2;
      while (i < text.length && text[i] !== 'm') i++;
      continue;
    }
    out += text[i];
  }
  return out;
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
