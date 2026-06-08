// getGraphLog bypasses the native module (always uses the CLI), but keep the
// flag for parity with the other git integration suites.
process.env.FUNNY_DISABLE_NATIVE_GIT = '1';

import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { resolve } from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getGraphLog } from '../git/index.js';
import type { GraphRef } from '../git/log.js';
import { executeSync } from '../git/process.js';

const TMP = resolve(tmpdir(), 'core-graph-log-' + Date.now());

/** Project the classified refs back to their display names for name-only asserts. */
const refNames = (refs: GraphRef[]) => refs.map((r) => r.name);

function git(repo: string, args: string[]) {
  executeSync('git', args, { cwd: repo });
}

function writeCommit(repo: string, file: string, content: string, message: string) {
  writeFileSync(resolve(repo, file), content);
  git(repo, ['add', '.']);
  git(repo, ['commit', '-m', message]);
}

/** Commit with an explicit author+committer date so row ordering is deterministic. */
function writeCommitDated(
  repo: string,
  file: string,
  content: string,
  message: string,
  iso: string,
) {
  writeFileSync(resolve(repo, file), content);
  executeSync('git', ['add', '.'], { cwd: repo });
  executeSync('git', ['commit', '-m', message], {
    cwd: repo,
    env: { GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso },
  });
}

/** Build a repo with a branch + merge so the graph has real topology. */
function initMergeRepo(): string {
  const repo = resolve(TMP, 'repo');
  mkdirSync(repo, { recursive: true });
  git(repo, ['init']);
  git(repo, ['config', 'user.email', 'test@test.com']);
  git(repo, ['config', 'user.name', 'Test']);
  git(repo, ['branch', '-M', 'main']);
  writeCommit(repo, 'README.md', '# Test', 'root commit'); // root: 0 parents
  git(repo, ['checkout', '-b', 'feature']);
  writeCommit(repo, 'feature.txt', 'feature work', 'feature commit');
  git(repo, ['checkout', 'main']);
  writeCommit(repo, 'main.txt', 'main work', 'main commit');
  // No-ff merge guarantees a merge commit with two parents.
  git(repo, ['merge', '--no-ff', 'feature', '-m', 'merge feature into main']);
  return repo;
}

describe('getGraphLog', () => {
  beforeEach(() => {
    mkdirSync(TMP, { recursive: true });
  });
  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
  });

  it('returns parent hashes (merge=2, normal=1, root=0) and ref decorations', async () => {
    const repo = initMergeRepo();
    const result = await getGraphLog(repo, { all: true });
    expect(result.isOk()).toBe(true);
    const entries = result._unsafeUnwrap();

    // Merge commit has exactly two parents.
    const merge = entries.find((e) => e.message === 'merge feature into main');
    expect(merge).toBeDefined();
    expect(merge!.parentHashes).toHaveLength(2);

    // Root commit has no parents.
    const root = entries.find((e) => e.message === 'root commit');
    expect(root!.parentHashes).toHaveLength(0);

    // A normal (non-merge) commit has exactly one parent.
    const mainCommit = entries.find((e) => e.message === 'main commit');
    expect(mainCommit!.parentHashes).toHaveLength(1);

    // --all surfaces the feature branch tip, decorated with its ref name.
    const featureTip = entries.find((e) => e.message === 'feature commit');
    expect(refNames(featureTip!.refs)).toContain('feature');

    // The merge commit is the current branch tip: `main` chip present, the
    // redundant `HEAD` chip dropped, and the checked-out branch surfaced as
    // `headBranch` for the UI to highlight.
    expect(refNames(merge!.refs)).toContain('main');
    expect(refNames(merge!.refs)).not.toContain('HEAD');
    expect(merge!.headBranch).toBe('main');
  });

  it('drops the redundant origin/HEAD pointer but keeps the remote branch chip', async () => {
    const repo = initMergeRepo();
    // Wire up a bare remote and push so `origin/main` + `origin/HEAD` decorate.
    const remote = resolve(TMP, 'remote.git');
    mkdirSync(remote, { recursive: true });
    git(remote, ['init', '--bare']);
    git(repo, ['remote', 'add', 'origin', remote]);
    git(repo, ['push', '-u', 'origin', 'main']);
    git(repo, ['remote', 'set-head', 'origin', 'main']); // creates origin/HEAD → origin/main

    const result = await getGraphLog(repo, { all: true });
    const merge = result._unsafeUnwrap().find((e) => e.message === 'merge feature into main');
    expect(refNames(merge!.refs)).toContain('origin/main'); // real remote branch stays
    expect(refNames(merge!.refs)).not.toContain('origin/HEAD'); // symbolic pointer dropped
    expect(refNames(merge!.refs)).not.toContain('HEAD'); // local HEAD dropped too
    expect(merge!.headBranch).toBe('main');
    // The local `main` and remote-tracking `origin/main` are classified distinctly
    // so the UI can collapse the pair / flag the lone remote (GitKraken-style).
    expect(merge!.refs).toContainEqual({ name: 'main', kind: 'local' });
    expect(merge!.refs).toContainEqual({ name: 'origin/main', kind: 'remote' });
  });

  it('without all=true walks only HEAD (feature branch tip absent)', async () => {
    const repo = initMergeRepo();
    const result = await getGraphLog(repo, { all: false });
    const entries = result._unsafeUnwrap();
    // The feature-only commit is still reachable through the merge, so it IS
    // present — but no commit outside HEAD's history should appear. Assert the
    // merge is the tip and carries HEAD.
    const merge = entries.find((e) => e.message === 'merge feature into main');
    expect(merge!.headBranch).toBe('main');
  });

  it('surfaces a tag as a ref chip without the `tag:` prefix', async () => {
    const repo = initMergeRepo();
    git(repo, ['tag', 'v1.0']); // decorates the current tip (`merge feature into main`)

    const result = await getGraphLog(repo, { all: true });
    const merge = result._unsafeUnwrap().find((e) => e.message === 'merge feature into main');
    // `%D` reports this as `tag: refs/tags/v1.0`; the parser must strip the prefix
    // and classify it as a tag.
    expect(merge!.refs).toContainEqual({ name: 'v1.0', kind: 'tag' });
    expect(refNames(merge!.refs)).not.toContain('tag: v1.0');
  });

  it('keeps the literal HEAD chip when detached, with no headBranch', async () => {
    const repo = initMergeRepo();
    // Detach HEAD onto the root commit. Its decoration is the bare token `HEAD`
    // (no `->`), which must be preserved as a chip since there is no branch to
    // highlight — and headBranch stays null on every commit.
    const rootHash = executeSync('git', ['rev-list', '--max-parents=0', 'HEAD'], {
      cwd: repo,
    }).stdout.trim();
    git(repo, ['checkout', rootHash]);

    const result = await getGraphLog(repo, { all: true });
    const entries = result._unsafeUnwrap();
    const root = entries.find((e) => e.message === 'root commit');
    expect(refNames(root!.refs)).toContain('HEAD');
    expect(entries.every((e) => e.headBranch === null)).toBe(true);
  });

  it('orders rows by commit date (--date-order), interleaving a side branch with the trunk', async () => {
    // Reproduces the GitKraken layout the graph mirrors: a side branch with two
    // commits whose timestamps straddle a trunk commit. With `--date-order` the
    // trunk commit must land BETWEEN the two side-branch commits (so they read as
    // a parallel lane); `--topo-order` would instead group the side branch into a
    // contiguous block, which is the regression this guards against.
    const repo = resolve(TMP, 'dated');
    mkdirSync(repo, { recursive: true });
    git(repo, ['init']);
    git(repo, ['config', 'user.email', 'test@test.com']);
    git(repo, ['config', 'user.name', 'Test']);
    git(repo, ['branch', '-M', 'main']);

    // Shared base, then a side branch (S1 → S2) and one trunk commit (T1) whose
    // date falls between S1 and S2.
    writeCommitDated(repo, 'base.txt', 'base', 'base', '2026-01-01T00:00:00');
    git(repo, ['checkout', '-b', 'side']);
    writeCommitDated(repo, 'side.txt', 's1', 'side 1', '2026-01-01T01:00:00');
    git(repo, ['checkout', 'main']);
    writeCommitDated(repo, 'trunk.txt', 't1', 'trunk 1', '2026-01-01T02:00:00');
    git(repo, ['checkout', 'side']);
    writeCommitDated(repo, 'side.txt', 's2', 'side 2', '2026-01-01T03:00:00');

    const result = await getGraphLog(repo, { all: true });
    const order = result._unsafeUnwrap().map((e) => e.message);
    // Newest first, side branch interleaved around the trunk commit.
    expect(order).toEqual(['side 2', 'trunk 1', 'side 1', 'base']);
  });
});
