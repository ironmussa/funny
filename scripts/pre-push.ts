// pre-push: run only the test suites the pushed commits can affect.
//
// Git passes one line per pushed ref on stdin:
//   <local ref> <local sha> <remote ref> <remote sha>
// For each ref the changed files are the diff from what the remote already has
// (or, for a new branch, from its merge base with origin/master) to the pushed
// commit. CI runs every suite on the PR, so this only has to catch the obvious
// breakage early, in seconds rather than minutes.
//
// A change to `bun.lock` or the root `package.json` selects only the packages
// declaring an external dependency it touches (see lockfile-changes.ts). A
// `bun test` suite with a test-impact map runs only the test files that
// executed a changed source (scripts/test-impact.ts; `fetch` downloads the
// maps CI builds).
//
// The suites run against the pushed commit, not the checkout's files: when the
// checkout is not that commit or has uncommitted changes (another agent's work
// in progress in a shared checkout), they run in a temporary worktree of it.
//
// Set FUNNY_PREPUSH_ALL=1 to run every suite anyway.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { changedDependencies, type DependencySnapshot } from './lockfile-changes';
import {
  declaredExternalDeps,
  discoverPackages,
  impactNarrower,
  planTests,
  runLabel,
  runTests,
} from './run-tests';
import { testSuiteEnv } from './test-env';

const ZERO_SHA = /^0+$/;
const DEFAULT_BASE = 'origin/master';

function git(cwd: string, args: string[]): string | null {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: testSuiteEnv(process.env) });
  return result.status === 0 ? result.stdout.trim() : null;
}

/** The commit the push is measured against, or null when none can be found. */
function baseFor(cwd: string, localSha: string, remoteSha: string, defaultBase: string) {
  // An existing remote branch we have locally: only the commits being added.
  // After a force push of a rebased branch the old tip may be missing locally.
  const remoteKnown = !ZERO_SHA.test(remoteSha) && git(cwd, ['cat-file', '-e', remoteSha]) !== null;
  return git(cwd, ['merge-base', remoteKnown ? remoteSha : defaultBase, localSha]);
}

/** One pushed ref: the commit pushed and the commit it is measured against. */
interface PushRange {
  base: string;
  head: string;
  files: string[];
}

/** The range of every ref in the pre-push `stdin`, or null when one cannot be resolved. */
function pushRanges(stdin: string, cwd: string, defaultBase: string): PushRange[] | null {
  const ranges: PushRange[] = [];
  for (const line of stdin.split('\n')) {
    const [, localSha, , remoteSha] = line.trim().split(/\s+/);
    if (!localSha || !remoteSha || ZERO_SHA.test(localSha)) continue;
    const base = baseFor(cwd, localSha, remoteSha, defaultBase);
    const diff = base && git(cwd, ['diff', '--name-only', base, localSha]);
    if (diff === null) return null;
    ranges.push({ base: base!, head: localSha, files: diff.split('\n').filter(Boolean) });
  }
  return ranges;
}

/** The pushed commits in the pre-push `stdin`, or null when a range cannot be resolved. */
export function pushedHeads(stdin: string, cwd = process.cwd(), defaultBase = DEFAULT_BASE) {
  return pushRanges(stdin, cwd, defaultBase)?.map((range) => range.head) ?? null;
}

/**
 * Files changed across every ref in the pre-push `stdin`, or null when a range
 * cannot be resolved (the caller then runs everything). Deletions add nothing.
 */
export function changedFiles(stdin: string, cwd = process.cwd(), defaultBase = DEFAULT_BASE) {
  const ranges = pushRanges(stdin, cwd, defaultBase);
  return ranges && [...new Set(ranges.flatMap((range) => range.files))];
}

/** `path` at `rev`, or null when it does not exist there. */
function fileAt(cwd: string, rev: string, path: string): string | null {
  const result = spawnSync('git', ['show', `${rev}:${path}`], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    env: testSuiteEnv(process.env),
  });
  return result.status === 0 ? result.stdout : null;
}

const snapshotAt = (cwd: string, rev: string): DependencySnapshot => ({
  lock: fileAt(cwd, rev, 'bun.lock'),
  rootManifest: fileAt(cwd, rev, 'package.json'),
});

/**
 * External dependencies the pushed `bun.lock` / root `package.json` changes
 * touch, across every ref: undefined when no ref changes them, null when a
 * change cannot be attributed (the caller then treats it as global).
 */
export function changedDependenciesOfPush(
  stdin: string,
  workspaceDeclared: ReadonlySet<string>,
  cwd = process.cwd(),
  defaultBase = DEFAULT_BASE,
): Set<string> | null | undefined {
  const ranges = pushRanges(stdin, cwd, defaultBase);
  if (ranges === null) return null;
  const touching = ranges.filter((range) =>
    range.files.some((file) => file === 'bun.lock' || file === 'package.json'),
  );
  if (touching.length === 0) return undefined;
  const all = new Set<string>();
  for (const { base, head } of touching) {
    const changed = changedDependencies(
      snapshotAt(cwd, base),
      snapshotAt(cwd, head),
      workspaceDeclared,
    );
    if (changed === null) return null;
    for (const name of changed) all.add(name);
  }
  return all;
}

/** Where the pushed commit's suites run, and how to clean it up. */
export interface TestCheckout {
  root: string;
  dispose: () => void;
  /** Why the suites run somewhere other than the pushed commit, if they do. */
  warning?: string;
}

function installDependencies(root: string): boolean {
  // --ignore-scripts: the root `prepare` script installs git hooks.
  const result = spawnSync('bun', ['install', '--frozen-lockfile', '--ignore-scripts'], {
    cwd: root,
    stdio: ['ignore', 'ignore', 'inherit'],
    env: testSuiteEnv(process.env),
  });
  return result.status === 0;
}

/**
 * The checkout to test `heads` in. The checkout itself when it is exactly the
 * one pushed commit with nothing uncommitted; otherwise a temporary worktree
 * at that commit, so another agent's unfinished edits in a shared checkout
 * cannot fail (or pass) the push. Several pushed commits run in place.
 */
export function testCheckout(
  heads: readonly string[],
  cwd = process.cwd(),
  install: (root: string) => boolean = installDependencies,
): TestCheckout {
  const inPlace = (warning?: string): TestCheckout => ({ root: cwd, dispose: () => {}, warning });
  if (heads.length !== 1) {
    return inPlace(
      heads.length > 1 ? 'several commits pushed; testing the checkout as it is' : undefined,
    );
  }
  const head = heads[0];
  const clean = git(cwd, ['status', '--porcelain']) === '';
  if (clean && git(cwd, ['rev-parse', 'HEAD']) === head) return inPlace();

  const dir = mkdtempSync(join(tmpdir(), 'funny-prepush-'));
  const dispose = () => {
    git(cwd, ['worktree', 'remove', '--force', dir]);
    rmSync(dir, { recursive: true, force: true });
    git(cwd, ['worktree', 'prune']);
  };
  if (git(cwd, ['worktree', 'add', '--detach', dir, head]) === null || !install(dir)) {
    dispose();
    return inPlace('could not prepare a worktree at the pushed commit; testing the checkout');
  }
  return { root: dir, dispose };
}

if (import.meta.main) {
  const stdin = await Bun.stdin.text();
  const heads = pushedHeads(stdin) ?? [];
  const checkout = testCheckout(heads);
  if (checkout.warning) console.log(`pre-push: ${checkout.warning}`);
  else if (checkout.root !== process.cwd()) {
    console.log(`pre-push: testing the pushed commit in ${checkout.root}`);
  }
  let code = 0;
  try {
    code = await testPush(stdin, heads, checkout.root);
  } finally {
    checkout.dispose();
  }
  process.exit(code);
}

async function testPush(stdin: string, heads: readonly string[], root: string): Promise<number> {
  const packages = discoverPackages(root);
  const files = process.env.FUNNY_PREPUSH_ALL ? null : changedFiles(stdin);
  const runs =
    files === null
      ? planTests([], packages, null, root)
      : planTests(
          files,
          packages,
          changedDependenciesOfPush(stdin, declaredExternalDeps(packages)),
          root,
          impactNarrower(heads, root),
        );

  if (runs.length === 0) {
    console.log('pre-push: no package test suite is affected by this push');
    return 0;
  }
  console.log(`pre-push: testing ${runs.map(runLabel).join(', ')}`);
  for (const run of runs) {
    if (run.note) console.log(`pre-push: ${run.pkg.name} runs whole (${run.note})`);
  }
  return runTests(runs, root);
}
