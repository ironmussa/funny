import { describe, expect, test } from 'bun:test';

import { okAsync } from 'neverthrow';

import {
  commentReview,
  createRepoGithub,
  REVIEW_STATUS_CONTEXT,
  setCommitStatus,
} from '../github-app/index.js';
import { fakeFetch } from './helpers/test-helpers.js';

/** A GitHub that answers `status` to everything and records the calls. */
function github(status = 200) {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  const fetchImpl = fakeFetch(async (url, init) => {
    calls.push({
      method: init?.method ?? 'GET',
      path: url.replace('https://api.github.com', ''),
      body: JSON.parse(String(init?.body ?? 'null')),
    });
    return new Response(JSON.stringify({ id: 1 }), { status });
  });
  return { github: createRepoGithub({ tokenFor: () => okAsync('tok'), fetch: fetchImpl }), calls };
}

describe('publishing a review verdict', () => {
  test('the review is a comment on the commit, never an approval', async () => {
    const { github: gh, calls } = github();
    const posted = await commentReview(gh, 'o/r', 7, { commitId: 'abc', body: 'Verdict: pass' });
    expect(posted.isOk()).toBe(true);
    expect(calls).toEqual([
      {
        method: 'POST',
        path: '/repos/o/r/pulls/7/reviews',
        body: { commit_id: 'abc', body: 'Verdict: pass', event: 'COMMENT' },
      },
    ]);
  });

  test('the status is set on the commit, with a description GitHub accepts', async () => {
    const { github: gh, calls } = github(201);
    const set = await setCommitStatus(gh, 'o/r', 'abc', {
      context: REVIEW_STATUS_CONTEXT,
      state: 'failure',
      description: 'x'.repeat(300),
    });
    expect(set.isOk()).toBe(true);
    expect(calls[0]).toMatchObject({
      method: 'POST',
      path: '/repos/o/r/statuses/abc',
      body: { state: 'failure', context: 'funny/review' },
    });
    expect(calls[0]?.body).toMatchObject({ description: 'x'.repeat(140) });
  });

  test('an installation without the permission answers an error, with its status', async () => {
    const { github: gh } = github(403);
    const set = await setCommitStatus(gh, 'o/r', 'abc', {
      context: REVIEW_STATUS_CONTEXT,
      state: 'success',
      description: 'ok',
    });
    expect(set._unsafeUnwrapErr().status).toBe(403);
  });
});
