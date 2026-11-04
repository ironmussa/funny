// Read-side caching / coalescing for the status and diff-summary scans. Pins
// the CLI path so the tests behave the same with or without the native module.
process.env.FUNNY_DISABLE_NATIVE_GIT = '1';

import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { resolve } from 'path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { getDiffSummary, getStatusSummary, invalidateStatusCache } from '../git/index.js';
import { executeSync, getGitWriteGeneration, gitWrite } from '../git/process.js';

const TMP = resolve(tmpdir(), 'core-git-read-coalescing-' + Date.now());

function run(cwd: string, args: string[]): string {
  return executeSync('git', args, { cwd }).stdout.trim();
}

function initRepo(): string {
  const repoPath = resolve(TMP, 'repo');
  mkdirSync(repoPath, { recursive: true });
  run(repoPath, ['init', '-b', 'master']);
  run(repoPath, ['config', 'user.email', 'test@test.com']);
  run(repoPath, ['config', 'user.name', 'Test']);
  writeFileSync(resolve(repoPath, 'base.txt'), 'a\n');
  run(repoPath, ['add', '-A']);
  run(repoPath, ['commit', '-m', 'init']);
  return repoPath;
}

async function unwrap<T>(result: PromiseLike<{ isErr(): boolean; value?: T; error?: unknown }>) {
  const r = await result;
  if (r.isErr()) throw new Error(String(r.error));
  return r.value as T;
}

describe('git read coalescing', () => {
  let repo: string;
  beforeEach(() => {
    mkdirSync(TMP, { recursive: true });
    invalidateStatusCache();
    repo = initRepo();
  });
  afterEach(() => {
    invalidateStatusCache();
    rmSync(TMP, { recursive: true, force: true });
  });

  test('gitWrite bumps the write generation', async () => {
    const before = getGitWriteGeneration();
    await gitWrite(['status'], { cwd: repo });
    expect(getGitWriteGeneration()).toBeGreaterThan(before);
  });

  test('status cache is not served after a git write', async () => {
    writeFileSync(resolve(repo, 'new.txt'), 'x\n');
    const dirty = await unwrap(getStatusSummary(repo));
    expect(dirty.dirtyFileCount).toBe(1);

    // Still inside the 1s TTL: without the write-generation guard the cached
    // dirty count would be returned here.
    await gitWrite(['add', '-A'], { cwd: repo });
    await gitWrite(['commit', '-m', 'add new'], { cwd: repo });
    const clean = await unwrap(getStatusSummary(repo));
    expect(clean.dirtyFileCount).toBe(0);
  });

  test('concurrent shared diff summaries reuse one scan', async () => {
    writeFileSync(resolve(repo, 'new.txt'), 'x\n');
    const [a, b] = await Promise.all([
      unwrap(getDiffSummary(repo, { shareInFlight: true })),
      unwrap(getDiffSummary(repo, { shareInFlight: true })),
    ]);
    expect(a).toBe(b);
    expect(a.files.map((f) => f.path)).toEqual(['new.txt']);
  });

  test('unshared diff summaries always run their own scan', async () => {
    const [a, b] = await Promise.all([
      unwrap(getDiffSummary(repo, { shareInFlight: true })),
      unwrap(getDiffSummary(repo)),
    ]);
    expect(a).not.toBe(b);
  });

  test('a diff summary requested after a git write does not join an older scan', async () => {
    writeFileSync(resolve(repo, 'new.txt'), 'x\n');
    const older = getDiffSummary(repo, { shareInFlight: true });
    await gitWrite(['add', 'new.txt'], { cwd: repo });
    const newer = await unwrap(getDiffSummary(repo, { shareInFlight: true }));
    await older;
    expect(newer.files).toEqual([expect.objectContaining({ path: 'new.txt', staged: true })]);
  });
});
