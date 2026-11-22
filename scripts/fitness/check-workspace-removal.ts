#!/usr/bin/env bun
/**
 * Fitness function: one runner module removes workspaces (track-funny-actions,
 * design D10).
 *
 * `packages/runtime/src/services/workspace-cleanup.ts` stops the processes
 * running inside a worktree, validates the target and records the removal as
 * an activity. Code that calls `removeWorktree`, `removeBranch` or
 * `pruneOrphanWorktrees` from `@funny/core/git` directly skips all three, so
 * this fails on any mention of those names in `packages/runtime/src` outside
 * that module, and anywhere in `packages/server/src` (the server asks the
 * thread's runner instead). Tests (`__tests__`, `*.test.ts`) are exempt.
 * Exits non-zero on violation; `--self-test` checks the fixtures.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = join(import.meta.dir, '..', '..');
const SCANNED = ['packages/runtime/src', 'packages/server/src'];
const OWNER = 'packages/runtime/src/services/workspace-cleanup.ts';
const NAMES = /\b(removeWorktree|removeBranch|pruneOrphanWorktrees)\b/g;

function stripComments(source: string): string {
  // Keep line count: blank out the comment text, not the newlines.
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (c) => ' '.repeat(c.length));
}

/** Violations for one source file (repo-relative path). */
export function classify(file: string, source: string): string[] {
  if (file === OWNER) return [];
  const code = stripComments(source);
  const violations: string[] = [];
  for (const match of code.matchAll(NAMES)) {
    const line = code.slice(0, match.index).split('\n').length;
    violations.push(
      `${file}:${line}: uses \`${match[1]}\` outside ${OWNER} (stop processes, validate, record: call cleanupWorkspace / pruneOrphans)`,
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
  const route = 'packages/runtime/src/routes/worktrees.ts';
  const allowed: Array<[string, string]> = [
    [OWNER, "import { removeWorktree, removeBranch } from '@funny/core/git';"],
    [route, "import { cleanupWorkspace } from '../services/workspace-cleanup.js';"],
    [route, '// removeWorktree used to be called here'],
    [route, '/* removeBranch */ const x = 1;'],
    [route, 'const removeWorktreeLater = 1;'],
  ];
  const forbidden: Array<[string, string, string]> = [
    [route, "import { removeWorktree } from '@funny/core/git';", 'removeWorktree'],
    [route, 'await removeBranch(project.path, branch);', 'removeBranch'],
    [
      'packages/runtime/src/services/pipeline-manager.ts',
      "const { pruneOrphanWorktrees } = await import('@funny/core/git');",
      'pruneOrphanWorktrees',
    ],
    ['packages/server/src/services/x.ts', 'git.removeWorktree(path)', 'removeWorktree'],
  ];
  for (const [file, source] of allowed) {
    const v = classify(file, source);
    if (v.length) throw new Error(`self-test: expected no violation for ${file}:\n${v.join('\n')}`);
  }
  for (const [file, source, name] of forbidden) {
    const v = classify(file, source);
    if (!v.some((m) => m.includes(`\`${name}\``))) {
      throw new Error(`self-test: expected a ${name} violation for ${file}: ${source}`);
    }
  }
  const [first] = classify(route, 'const a = 1;\n\nawait removeWorktree(p, w);');
  if (!first?.startsWith(`${route}:3:`)) throw new Error(`self-test: wrong line in ${first}`);
  console.log('workspace removal self-test ok');
}

function main(): void {
  if (process.argv.includes('--self-test')) runSelfTest();
  const violations: string[] = [];
  for (const dir of SCANNED) {
    for (const abs of walk(join(ROOT, dir))) {
      const file = relative(ROOT, abs).split(sep).join('/');
      violations.push(...classify(file, readFileSync(abs, 'utf8')));
    }
  }
  if (violations.length > 0) {
    console.error(`Workspace removal outside ${OWNER}:\n${violations.join('\n')}`);
    process.exit(1);
  }
  console.log('workspace removal ok');
}

main();
