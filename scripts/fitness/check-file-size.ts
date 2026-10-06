#!/usr/bin/env bun
// Fitness function: file-size ceiling.
//
// No source file under packages/<name>/src may exceed MAX_LINES, except
// those on the explicit WAIVERS list. Adding to the waiver list is a
// conscious act: every entry carries a target size so the waiver shrinks
// over time.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dir, '..', '..');
const MAX_LINES = 1500;

// Explicit waivers with target sizes. Each entry is "eventual max" — the
// fitness function allows the file UP TO `current` today, so nothing breaks,
// but the goal is to drive these down toward MAX_LINES.
//
// DO NOT add new entries without a decomposition plan in the PR description.
const WAIVERS: Record<string, { current: number; target: number; note: string }> = {
  'packages/client/src/components/ReviewPane.tsx': {
    current: 3500,
    target: 800,
    note: 'Decompose into DiffList/DiffPanel/StagingBar/CommitBox/PRActions.',
  },
  'packages/evflow/models/funny-runtime.model.ts': {
    current: 1500,
    target: 1500,
    note: 'Generated-ish DSL shape; keep but do not grow.',
  },
};

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '__tests__') continue;
    const full = join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) yield* walk(full);
    else if (
      /\.(ts|tsx)$/.test(entry) &&
      !entry.endsWith('.test.ts') &&
      !entry.endsWith('.test.tsx') &&
      !entry.endsWith('.spec.ts')
    ) {
      yield full;
    }
  }
}

const pkgDirs = [
  'packages/shared/src',
  'packages/core/src',
  'packages/runtime/src',
  'packages/server/src',
  'packages/client/src',
];

const violations: string[] = [];
const waiverWarnings: string[] = [];
const waiverBreaches: string[] = [];

for (const pkgDir of pkgDirs) {
  const abs = join(ROOT, pkgDir);
  try {
    for (const file of walk(abs)) {
      const rel = relative(ROOT, file);
      const lines = readFileSync(file, 'utf8').split('\n').length;
      const waiver = WAIVERS[rel];

      if (waiver) {
        if (lines > waiver.current) {
          waiverBreaches.push(
            `${rel}: ${lines} lines exceeds waiver current=${waiver.current} (target=${waiver.target}). ${waiver.note}`,
          );
        } else if (lines > waiver.target) {
          waiverWarnings.push(`${rel}: ${lines} (target ${waiver.target})`);
        }
        continue;
      }

      if (lines > MAX_LINES) {
        violations.push(`${rel}: ${lines} lines (limit ${MAX_LINES})`);
      }
    }
  } catch {
    // skip
  }
}

let failed = false;

if (violations.length > 0) {
  console.error(`\nFile-size violations (limit ${MAX_LINES} lines, no waiver):`);
  for (const v of violations) console.error('  ' + v);
  console.error(
    `\n${violations.length} violation(s). Either decompose the file or add a waiver with a decomposition plan.`,
  );
  failed = true;
}

if (waiverBreaches.length > 0) {
  console.error(`\nWaiver breaches (file grew past its current waiver ceiling):`);
  for (const b of waiverBreaches) console.error('  ' + b);
  failed = true;
}

if (waiverWarnings.length > 0) {
  console.log(`\nWaiver warnings (file under ceiling, above target — shrink when you touch it):`);
  for (const w of waiverWarnings) console.log('  ' + w);
}

if (failed) process.exit(1);
console.log(`\nfile-size ok — no file over ${MAX_LINES} lines outside the waiver list`);
