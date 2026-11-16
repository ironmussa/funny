#!/usr/bin/env bun
/**
 * Fitness function: one writer per guarded status table (state machines).
 *
 * These tables carry a lifecycle `status` whose transitions are checked where
 * it is written: a compare-and-set against the legal from-states (see
 * docs/architecture/state-machines.md). A write anywhere else skips that check
 * and brings back the race it closed, so this fails when production code
 * outside a table's owner calls `.update(<table>)` on it.
 *
 * Inside the owners (the shared repositories) the table is usually reached as
 * `table`, which this does not match on purpose: the owner is where the rule is
 * implemented. Tests (`__tests__`, `*.test.ts`) are exempt. Exits non-zero on
 * violation; `--self-test` checks the allowed and forbidden fixtures.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dir, '..', '..');
const SCANNED = [
  'packages/server/src',
  'packages/runtime/src',
  'packages/shared/src',
  'packages/scheduler/src',
];

/** Table identifier (as the Drizzle schema exports it) → files allowed to update it, and why. */
const OWNERS: Record<string, { files: string[]; why: string }> = {
  threadSandboxes: {
    files: ['packages/server/src/services/thread-sandboxes/thread-sandbox-store.ts'],
    why: 'sandbox-machine transitions (ThreadSandboxStore.transition)',
  },
  watchers: {
    files: ['packages/shared/src/repositories/watcher-repository.ts'],
    why: 'watcher-machine guard (watcher repository update)',
  },
  jobs: {
    files: ['packages/shared/src/repositories/job-repository.ts'],
    why: 'job-machine guard (job repository update)',
  },
  runnerEnrollments: {
    files: ['packages/server/src/services/runner-enrollment-service.ts'],
    why: 'pending → approved → consumed compare-and-set',
  },
  runnerTasks: {
    files: ['packages/server/src/services/runner-manager.ts'],
    why: 'task claim and completion compare-and-set',
  },
  automationRuns: {
    files: [
      'packages/server/src/services/automation-repository.ts',
      // The stale-run sweep: a compare-and-set on `running`.
      'packages/server/src/services/automation-scheduler.ts',
      // Triage status only (pending / reviewed / dismissed), not the run status.
      'packages/server/src/trpc/ports/automations.ts',
    ],
    why: 'finishRunningRun and the stale sweep compare-and-set on running',
  },
  schedulerRuns: {
    files: ['packages/shared/src/repositories/scheduler-run-repository.ts'],
    why: 'scheduler run repository',
  },
  pendingPermissionRequests: {
    files: ['packages/shared/src/repositories/pending-permission-repository.ts'],
    why: 'compare-and-set on status = active',
  },
};

const TABLES = Object.keys(OWNERS).join('|');
// `.update(watchers)`, `.update(schema.watchers)`, across a line break too.
const UPDATE = new RegExp(String.raw`\.update\(\s*(?:[A-Za-z_$][\w$]*\.)?(${TABLES})\s*\)`, 'g');

function stripComments(source: string): string {
  // Keep line count: blank out the comment text, not the newlines.
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (c) => ' '.repeat(c.length));
}

/** Violations for one source file (repo-relative path). */
export function classify(file: string, source: string): string[] {
  const code = stripComments(source);
  const violations: string[] = [];
  for (const match of code.matchAll(UPDATE)) {
    const table = match[1]!;
    const owner = OWNERS[table]!;
    if (owner.files.includes(file)) continue;
    const line = code.slice(0, match.index).split('\n').length;
    violations.push(
      `${file}:${line}: writes \`${table}\` outside its owner (${owner.files[0]}: ${owner.why})`,
    );
  }
  return violations;
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '__tests__') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) yield full;
  }
}

function runSelfTest(): void {
  const route = 'packages/server/src/trpc/ports/background.ts';
  const allowed: Array<[string, string]> = [
    [OWNERS.watchers!.files[0]!, 'await db.update(table).set({ status });'],
    [
      OWNERS.runnerTasks!.files[0]!,
      'await db\n  .update(runnerTasks)\n  .set({ status: "running" });',
    ],
    [OWNERS.threadSandboxes!.files[0]!, 'db.update(threadSandboxes).set({ state: rule.to })'],
    [route, '// db.update(watchers).set({ status: "cancelled" }) — commented out'],
    [route, '/* .update(jobs) */ const x = 1;'],
    [route, 'await repos.watchers().update(id, { status: "cancelled" });'],
    [route, 'await db.update(projects).set({ name });'],
  ];
  const forbidden: Array<[string, string, string]> = [
    [route, 'await db.update(watchers).set({ status: "cancelled" });', 'watchers'],
    [route, 'await db\n  .update(jobs)\n  .set({ status });', 'jobs'],
    [route, 'db.update(schema.automationRuns).set(patch)', 'automationRuns'],
    ['packages/runtime/src/x.ts', 'await tx.update( threadSandboxes ).set({});', 'threadSandboxes'],
  ];
  for (const [file, source] of allowed) {
    const v = classify(file, source);
    if (v.length) throw new Error(`self-test: expected no violation for ${file}:\n${v.join('\n')}`);
  }
  for (const [file, source, table] of forbidden) {
    const v = classify(file, source);
    if (!v.some((m) => m.includes(`\`${table}\``))) {
      throw new Error(`self-test: expected a ${table} violation for ${file}: ${source}`);
    }
  }
  // A violation reports the line the update is on.
  const [first] = classify(route, 'const a = 1;\n\nawait db.update(jobs).set({});');
  if (!first?.startsWith(`${route}:3:`)) throw new Error(`self-test: wrong line in ${first}`);
  console.log('status writers self-test ok');
}

function main(): void {
  if (process.argv.includes('--self-test')) runSelfTest();
  const violations: string[] = [];
  for (const dir of SCANNED) {
    for (const abs of walk(join(ROOT, dir))) {
      violations.push(...classify(relative(ROOT, abs), readFileSync(abs, 'utf8')));
    }
  }
  if (violations.length) {
    console.error(
      `status writers: ${violations.length} write(s) to a guarded status table outside its owner\n  ${violations.join('\n  ')}\n` +
        'Go through the owner, which checks the transition (docs/architecture/state-machines.md).',
    );
    process.exit(1);
  }
  console.log('status writers ok — every guarded status table is written only by its owner');
}

main();
