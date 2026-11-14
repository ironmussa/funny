/**
 * The whole issue factory once a pull request is green: marked ready only,
 * or merged through GitHub's auto-merge without bypassing branch protections,
 * then cleaned up. See `helpers/factory-harness.ts` for the seam.
 *
 * Tests observe GitHub's state (the pull request, how it merged, deleted
 * branches), the run's directory on disk, and `status`.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, readdirSync } from 'fs';
import { join } from 'path';

import {
  createFactoryHarness,
  git,
  LOGIN,
  MIN,
  type FactoryHarness,
} from './helpers/factory-harness.js';
import type { FakeCheck } from './helpers/fake-github-api.js';

const POLL = 3 * MIN;
const green: FakeCheck[] = [{ name: 'unit', status: 'completed', conclusion: 'success' }];

let h: FactoryHarness;
beforeEach(() => {
  h = createFactoryHarness();
  h.github.addIssue({
    number: 7,
    author: LOGIN,
    title: 'Add a greeting',
    labels: ['ready-for-agent'],
  });
});
afterEach(() => h.cleanup());

async function tick(f: { tick(): Promise<void>; idle(): Promise<void> }) {
  await f.tick();
  await f.idle();
}

/** A factory whose pull request for #7 is open and green; `prepare` runs before CI is read. */
async function greenPullRequest(autoMerge: boolean, prepare: () => void = () => {}) {
  const built = h.factory(undefined, { auto_merge: autoMerge });
  await tick(built.factory);
  const pull = h.github.pulls[0];
  pull.checks = green;
  prepare();
  h.clock.advance(POLL);
  await tick(built.factory);
  return { ...built, pull };
}

const runDir = () => join(h.home, 'runs', readdirSync(join(h.home, 'runs'))[0]);

describe('a green pull request', () => {
  test('with auto-merge off is only marked ready', async () => {
    const { factory: f, store, pull } = await greenPullRequest(false);
    h.clock.advance(POLL);
    await tick(f);
    store.close();

    expect(pull).toMatchObject({ draft: false, autoMerge: null, merged: false, state: 'open' });
    expect(await h.status()).toContain('ready');
  });

  test('with auto-merge on is merged with squash, then its workspace and branch are removed', async () => {
    const { store, pull } = await greenPullRequest(true);
    store.close();

    expect(pull).toMatchObject({ merged: true, mergedWith: 'squash' });
    expect(h.github.deletedBranches).toEqual([pull.head]);
    expect(existsSync(join(runDir(), 'worktree'))).toBe(false);
    expect(existsSync(join(runDir(), 'gh'))).toBe(false);
    expect(existsSync(join(runDir(), 'events.jsonl'))).toBe(true);
    expect(git(h.project, 'branch', '--list', pull.head)).toBe('');
    expect(await h.status()).toContain('merged');
  });

  test('uses another allowed method when the repository does not allow squash', async () => {
    const { store, pull } = await greenPullRequest(true, () => {
      h.github.repoSettings.allow_squash_merge = false;
    });
    store.close();
    expect(pull).toMatchObject({ merged: true, mergedWith: 'merge' });
  });

  test('that needs a review waits for it through auto-merge; nothing bypasses it', async () => {
    let pull = h.github.pulls[0];
    const built = await greenPullRequest(true, () => {
      pull = h.github.pulls[0];
      pull.requiresReview = true;
    });
    for (let i = 0; i < 3; i++) {
      h.clock.advance(POLL);
      await tick(built.factory);
    }
    expect(pull).toMatchObject({ merged: false, autoMerge: { method: 'squash' } });
    expect(await h.status()).toContain('merging');

    pull.approved = true;
    h.clock.advance(POLL);
    await tick(built.factory);
    built.store.close();
    expect(pull).toMatchObject({ merged: true, mergedWith: 'squash' });
    expect(await h.status()).toContain('merged');
  });

  test('stays ready when the repository does not allow auto-merge', async () => {
    const { store, pull } = await greenPullRequest(true, () => {
      h.github.repoSettings.allow_auto_merge = false;
    });
    store.close();
    expect(pull).toMatchObject({ draft: false, merged: false });
    const out = await h.status();
    expect(out).toContain('ready');
    expect(out).toContain('does not allow auto-merge');
  });

  test('a factory run waiting to merge holds no concurrency slot', async () => {
    const built = h.factory(undefined, { auto_merge: true, limits: { concurrency: 1, daily: 10 } });
    await tick(built.factory);
    const first = h.github.pulls[0];
    first.checks = green;
    first.requiresReview = true;
    h.clock.advance(POLL);
    await tick(built.factory);
    expect(await h.status()).toContain('merging');

    // A new ready issue while the only slot's run waits to merge.
    h.github.addIssue({ number: 8, author: LOGIN, title: 'Another', labels: ['ready-for-agent'] });
    await tick(built.factory);
    built.store.close();
    expect(h.github.pulls.map((p) => p.title)).toEqual(['Add a greeting', 'Another']);
  });

  test('closed without merging, the factory run fails and the issue is handed back', async () => {
    const built = await greenPullRequest(true, () => {
      h.github.pulls[0].requiresReview = true;
    });
    h.github.pulls[0].state = 'closed';
    h.clock.advance(POLL);
    await tick(built.factory);
    built.store.close();

    const out = await h.status();
    expect(out).toContain('failed');
    expect(out).toContain('closed without merging');
    expect(h.github.issues.get(7)!.comments.at(-1)!.body).toContain('closed without merging');
  });

  test('marked ready and later merged by a person, the factory run is cleaned up', async () => {
    const { factory: f, store, pull } = await greenPullRequest(false);
    pull.merged = true;
    pull.state = 'closed';
    h.clock.advance(30 * MIN);
    await tick(f);
    store.close();

    expect(await h.status()).toContain('merged');
    expect(h.github.deletedBranches).toEqual([pull.head]);
    expect(existsSync(join(runDir(), 'worktree'))).toBe(false);
  });

  test('tries the merge methods in order when GitHub does not show the settings', async () => {
    const { store, pull } = await greenPullRequest(true, () => {
      h.github.hideMergeSettings = true;
      h.github.repoSettings.allow_squash_merge = false;
    });
    store.close();
    expect(pull).toMatchObject({ merged: true, mergedWith: 'merge' });
  });

  test('a direct merge GitHub refuses (405) keeps waiting, and merges once it can', async () => {
    const built = await greenPullRequest(true, () => {
      h.github.refuseDirectMerge = true;
    });
    const pull = h.github.pulls[0];
    expect(pull.merged).toBe(false);
    expect(await h.status()).toContain('merging');

    h.github.refuseDirectMerge = false;
    h.clock.advance(POLL);
    await tick(built.factory);
    built.store.close();
    expect(pull).toMatchObject({ merged: true, mergedWith: 'squash' });
  });

  test('auto-merge turned off while the pull request stays green is enabled again', async () => {
    const built = await greenPullRequest(true, () => {
      h.github.pulls[0].requiresReview = true;
    });
    const pull = h.github.pulls[0];
    expect(pull.autoMerge).not.toBeNull();
    pull.autoMerge = null; // a person (or a push) turned it off
    h.clock.advance(POLL);
    await tick(built.factory);
    built.store.close();
    expect(h.github.pulls[0].autoMerge).toEqual({ method: 'squash' });
  });

  test('a pull request that turns red while waiting to merge goes back to the fix loop', async () => {
    const built = await greenPullRequest(true, () => {
      h.github.pulls[0].requiresReview = true;
    });
    const pull = h.github.pulls[0];
    pull.checks = [{ name: 'unit', status: 'completed', conclusion: 'failure', log: 'red' }];
    h.clock.advance(POLL);
    await tick(built.factory);
    h.clock.advance(POLL);
    await tick(built.factory);
    built.store.close();

    const states = h
      .events()
      .filter((e) => e.event_type === 'factory.run_state')
      .map((e) => e.data.state);
    expect(states.slice(-4)).toEqual(['merging', 'waiting_ci', 'fixing', 'waiting_ci']);
  });

  test('a cleanup that fails is tried again before the factory run is merged', async () => {
    const built = await greenPullRequest(true, () => {
      h.github.fail('DELETE', `/git/refs/heads/${h.github.pulls[0].head}`);
    });
    expect(await h.status()).toContain('cleanup incomplete');
    expect(await h.status()).not.toMatch(/\bmerged\s+-/);

    h.github.heal('DELETE', `/git/refs/heads/${h.github.pulls[0].head}`);
    h.clock.advance(POLL);
    await tick(built.factory);
    built.store.close();
    expect(h.github.deletedBranches).toEqual([h.github.pulls[0].head]);
    const out = await h.status();
    expect(out).toContain('merged');
    expect(out).not.toContain('cleanup incomplete');
  });
});
