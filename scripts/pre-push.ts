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
// declaring an external dependency it touches (see lockfile-changes.ts), and a
// vitest suite selected by source changes runs only the tests related to them.
//
// Set FUNNY_PREPUSH_ALL=1 to run every suite anyway.

import { spawnSync } from 'node:child_process';

import { changedDependencies, type DependencySnapshot } from './lockfile-changes';
import { declaredExternalDeps, discoverPackages, planTests, runTests } from './run-tests';
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

if (import.meta.main) {
  const packages = discoverPackages();
  const stdin = await Bun.stdin.text();
  const files = process.env.FUNNY_PREPUSH_ALL ? null : changedFiles(stdin);
  const runs =
    files === null
      ? planTests([], packages, null)
      : planTests(
          files,
          packages,
          changedDependenciesOfPush(stdin, declaredExternalDeps(packages)),
        );

  if (runs.length === 0) {
    console.log('pre-push: no package test suite is affected by this push');
    process.exit(0);
  }
  const label = ({ pkg, related }: (typeof runs)[number]) =>
    related ? `${pkg.name} (related)` : pkg.name;
  console.log(`pre-push: testing ${runs.map(label).join(', ')}`);
  process.exit(await runTests(runs));
}
