// pre-push: run only the test suites the pushed commits can affect.
//
// Git passes one line per pushed ref on stdin:
//   <local ref> <local sha> <remote ref> <remote sha>
// For each ref the changed files are the diff from what the remote already has
// (or, for a new branch, from its merge base with origin/master) to the pushed
// commit. CI runs every suite on the PR, so this only has to catch the obvious
// breakage early, in seconds rather than minutes.
//
// Set FUNNY_PREPUSH_ALL=1 to run every suite anyway.

import { spawnSync } from 'node:child_process';

import { discoverPackages, runTests, selectAffectedPackages } from './run-tests';
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

/**
 * Files changed across every ref in the pre-push `stdin`, or null when a range
 * cannot be resolved (the caller then runs everything). Deletions add nothing.
 */
export function changedFiles(stdin: string, cwd = process.cwd(), defaultBase = DEFAULT_BASE) {
  const files = new Set<string>();
  for (const line of stdin.split('\n')) {
    const [, localSha, , remoteSha] = line.trim().split(/\s+/);
    if (!localSha || !remoteSha || ZERO_SHA.test(localSha)) continue;
    const base = baseFor(cwd, localSha, remoteSha, defaultBase);
    const diff = base && git(cwd, ['diff', '--name-only', base, localSha]);
    if (diff === null) return null;
    for (const file of diff.split('\n')) if (file) files.add(file);
  }
  return [...files];
}

if (import.meta.main) {
  const packages = discoverPackages();
  const files = process.env.FUNNY_PREPUSH_ALL ? null : changedFiles(await Bun.stdin.text());
  const selected =
    files === null
      ? packages.filter((pkg) => pkg.hasTest)
      : selectAffectedPackages(files, packages);

  if (selected.length === 0) {
    console.log('pre-push: no package test suite is affected by this push');
    process.exit(0);
  }
  console.log(`pre-push: testing ${selected.map((pkg) => pkg.name).join(', ')}`);
  process.exit(await runTests(selected));
}
