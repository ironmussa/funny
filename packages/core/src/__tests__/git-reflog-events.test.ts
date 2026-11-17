// Reflog parsing always uses the CLI path.
process.env.FUNNY_DISABLE_NATIVE_GIT = '1';

import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { resolve } from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Count the `git patch-id` runs: one per computation of the commit pairs.
const patchIdRuns = vi.hoisted(() => ({ count: 0 }));
vi.mock('../git/process.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../git/process.js')>();
  return {
    ...actual,
    execute: (...args: Parameters<typeof actual.execute>) => {
      if (args[0] === 'git' && args[1][0] === 'patch-id') patchIdRuns.count += 1;
      return actual.execute(...args);
    },
  };
});

import { getRebaseReflogEvents } from '../git/index.js';
import { executeSync } from '../git/process.js';
import { clearRebasePairsCache } from '../git/rebase-pairs-cache.js';

const TMP = resolve(tmpdir(), 'core-reflog-events-' + Date.now());

function git(repo: string, args: string[]) {
  executeSync('git', args, { cwd: repo });
}

function commitFile(repo: string, file: string, content: string, message: string) {
  writeFileSync(resolve(repo, file), content);
  git(repo, ['add', '.']);
  git(repo, ['commit', '-m', message]);
}

function initRebasedRepo(): {
  repo: string;
  originalOne: string;
  originalTwo: string;
  rebasedOne: string;
  rebasedTwo: string;
} {
  const repo = resolve(TMP, 'repo');
  mkdirSync(repo, { recursive: true });
  git(repo, ['init']);
  git(repo, ['config', 'user.email', 'test@test.com']);
  git(repo, ['config', 'user.name', 'Test']);
  git(repo, ['branch', '-M', 'main']);
  commitFile(repo, 'base.txt', 'base', 'base');

  git(repo, ['checkout', '-b', 'feature']);
  commitFile(repo, 'feature-one.txt', 'one', 'feature one');
  const originalOne = executeSync('git', ['rev-parse', 'HEAD'], { cwd: repo }).stdout.trim();
  commitFile(repo, 'feature-two.txt', 'two', 'feature two');
  const originalTwo = executeSync('git', ['rev-parse', 'HEAD'], { cwd: repo }).stdout.trim();
  git(repo, ['branch', 'feature-before-rebase']);

  git(repo, ['checkout', 'main']);
  commitFile(repo, 'main.txt', 'main', 'main work');

  git(repo, ['checkout', 'feature']);
  git(repo, ['rebase', 'main']);
  const rebasedTwo = executeSync('git', ['rev-parse', 'HEAD'], { cwd: repo }).stdout.trim();
  const rebasedOne = executeSync('git', ['rev-parse', 'HEAD~1'], { cwd: repo }).stdout.trim();
  return { repo, originalOne, originalTwo, rebasedOne, rebasedTwo };
}

describe('getRebaseReflogEvents', () => {
  beforeEach(() => {
    mkdirSync(TMP, { recursive: true });
    clearRebasePairsCache();
    patchIdRuns.count = 0;
  });

  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
  });

  it('groups rebase reflog steps into a completed event', async () => {
    const { repo, originalOne, originalTwo, rebasedOne, rebasedTwo } = initRebasedRepo();

    const result = await getRebaseReflogEvents(repo);
    expect(result.isOk()).toBe(true);
    const event = result._unsafeUnwrap()[0];

    expect(event).toMatchObject({
      kind: 'rebase',
      branch: 'feature',
      onto: 'main',
      completed: true,
    });
    expect(event.startedAt).toBeTruthy();
    expect(event.finishedAt).toBeTruthy();
    expect(event.startHash).toBeTruthy();
    expect(event.finishHash).toBeTruthy();
    expect(event.steps.map((step) => step.action)).toEqual(
      expect.arrayContaining(['start', 'pick', 'finish']),
    );
    expect(event.steps.map((step) => step.message)).toEqual(
      expect.arrayContaining(['feature one', 'feature two']),
    );
    expect(event.commitHashes).toHaveLength(2);
    expect(event.commitPairs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          originalHash: originalOne,
          rebasedHash: rebasedOne,
          subject: 'feature one',
        }),
        expect.objectContaining({
          originalHash: originalTwo,
          rebasedHash: rebasedTwo,
          subject: 'feature two',
        }),
      ]),
    );
  });

  it('reuses the commit pairs until a new rebase reaches the reflog', async () => {
    const { repo, originalOne, rebasedOne } = initRebasedRepo();

    const first = (await getRebaseReflogEvents(repo))._unsafeUnwrap();
    expect(patchIdRuns.count).toBe(1);

    // A plain commit adds a reflog entry but no rebase step, so the pairs come
    // from the cache.
    commitFile(repo, 'later.txt', 'later', 'later work');
    const second = (await getRebaseReflogEvents(repo))._unsafeUnwrap();
    expect(patchIdRuns.count).toBe(1);
    expect(second[0].commitPairs).toEqual(first[0].commitPairs);
    expect(second[0].commitPairs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ originalHash: originalOne, rebasedHash: rebasedOne }),
      ]),
    );

    // A new rebase changes the events, so the pairs are computed again.
    git(repo, ['checkout', 'main']);
    commitFile(repo, 'main-two.txt', 'main two', 'more main work');
    git(repo, ['checkout', 'feature']);
    git(repo, ['rebase', 'main']);
    const third = (await getRebaseReflogEvents(repo))._unsafeUnwrap();
    expect(patchIdRuns.count).toBe(2);
    expect(third).toHaveLength(2);
    expect(third[0].commitPairs.length).toBeGreaterThan(0);
  });

  it('shares one computation between concurrent requests', async () => {
    const { repo } = initRebasedRepo();

    const [a, b] = await Promise.all([getRebaseReflogEvents(repo), getRebaseReflogEvents(repo)]);
    expect(patchIdRuns.count).toBe(1);
    expect(a._unsafeUnwrap()[0].commitPairs).toEqual(b._unsafeUnwrap()[0].commitPairs);
  });
});
