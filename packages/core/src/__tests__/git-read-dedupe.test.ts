// Read-side dedupe for the expensive working-tree scans: concurrent identical
// diff-summary scans share one run, and no cached/in-flight read survives a
// gitWrite (stage, commit, …) so the review pane never shows pre-write state.

import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { resolve } from 'path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { getDiffSummary, getStatusSummary, invalidateStatusCache } from '../git/index.js';
import { executeSync, getGitWriteGeneration, gitWrite } from '../git/process.js';

const TMP = resolve(tmpdir(), 'core-git-read-dedupe-' + Date.now());

function run(cwd: string, args: string[]): void {
  executeSync('git', args, { cwd });
}

function initRepo(): string {
  mkdirSync(TMP, { recursive: true });
  run(TMP, ['init', '-b', 'master']);
  run(TMP, ['config', 'user.email', 'test@test.com']);
  run(TMP, ['config', 'user.name', 'Test']);
  writeFileSync(resolve(TMP, 'base.txt'), 'a\n');
  run(TMP, ['add', '-A']);
  run(TMP, ['commit', '-m', 'init']);
  return TMP;
}

async function diffSummary(cwd: string, shareInFlight: boolean) {
  const result = await getDiffSummary(cwd, { shareInFlight });
  if (result.isErr()) throw new Error(String(result.error));
  return result.value;
}

describe('git read dedupe', () => {
  let repo: string;
  beforeEach(() => {
    invalidateStatusCache();
    repo = initRepo();
  });
  afterEach(() => {
    invalidateStatusCache();
    rmSync(TMP, { recursive: true, force: true });
  });

  test('concurrent shareInFlight diff summaries share one scan', async () => {
    writeFileSync(resolve(repo, 'base.txt'), 'a\nb\n');
    const [first, second] = await Promise.all([diffSummary(repo, true), diffSummary(repo, true)]);
    expect(second).toBe(first);
    expect(first.files.map((f) => f.path)).toEqual(['base.txt']);
  });

  test('diff summaries without shareInFlight always scan', async () => {
    const [first, second] = await Promise.all([diffSummary(repo, false), diffSummary(repo, false)]);
    expect(second).not.toBe(first);
  });

  test('gitWrite bumps the write generation', async () => {
    const before = getGitWriteGeneration();
    await gitWrite(['status'], { cwd: repo });
    expect(getGitWriteGeneration()).toBeGreaterThan(before);
  });

  test('a diff summary requested after a write never joins a pre-write scan', async () => {
    writeFileSync(resolve(repo, 'base.txt'), 'a\nb\n');
    const preWrite = diffSummary(repo, true);
    await gitWrite(['add', 'base.txt'], { cwd: repo });
    const postWrite = await diffSummary(repo, true);
    await preWrite;
    expect(postWrite.files).toEqual([expect.objectContaining({ path: 'base.txt', staged: true })]);
  });

  test('the cached status summary is not served after a write', async () => {
    writeFileSync(resolve(repo, 'base.txt'), 'a\nb\n');
    const dirty = await getStatusSummary(repo);
    expect(dirty._unsafeUnwrap().dirtyFileCount).toBe(1);

    await gitWrite(['commit', '-am', 'second'], { cwd: repo });

    // Well inside the 1s TTL: without the write-generation check this returned
    // the stale pre-commit summary.
    const clean = await getStatusSummary(repo);
    expect(clean._unsafeUnwrap().dirtyFileCount).toBe(0);
  });
});
