/** GitHub writes from the review pane are recorded (track-user-and-scheduled-actions, D3). */
import { describe, expect, test, vi } from 'bun:test';

import { recordedGithubWrite, type GithubWrite } from '../../services/github-write-activity.js';

const WRITE: GithubWrite = {
  userId: 'u1',
  projectId: 'p1',
  title: 'Merge o/r#7',
  input: { action: 'pr-merge', prNumber: 7, repo: 'o/r' },
  effectsOf: () => [{ effect: 'pr-merged', target: 'o/r#7' }],
  resultRefOf: () => ({ prUrl: 'https://github.com/o/r/pull/7' }),
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('recordedGithubWrite', () => {
  test('a success is recorded with its effects and answers what the route answered', async () => {
    const record = vi.fn(async (_spec: unknown, _outcome: unknown) => undefined);
    const res = await recordedGithubWrite(WRITE, async () => json(200, { merged: true }), record);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ merged: true });
    expect(record).toHaveBeenCalledWith(
      {
        kind: 'github.write',
        userId: 'u1',
        projectId: 'p1',
        title: 'Merge o/r#7',
        input: { action: 'pr-merge', prNumber: 7, repo: 'o/r' },
        origin: 'user',
      },
      {
        ok: true,
        effects: [{ effect: 'pr-merged', target: 'o/r#7' }],
        resultRef: { prUrl: 'https://github.com/o/r/pull/7' },
      },
    );
  });

  test("GitHub's refusal is recorded as a failure with its message", async () => {
    const record = vi.fn(async (_spec: unknown, _outcome: unknown) => undefined);
    const res = await recordedGithubWrite(
      WRITE,
      async () => json(409, { error: 'Pull Request is not mergeable' }),
      record,
    );
    expect(res.status).toBe(409);
    expect(record.mock.calls[0]![1]).toEqual({
      ok: false,
      error: 'Pull Request is not mergeable',
    });
  });

  test('the recorded input is only what the caller declared (no token)', async () => {
    const record = vi.fn(async (_spec: unknown, _outcome: unknown) => undefined);
    await recordedGithubWrite(WRITE, async () => json(200, { token: 'ghp_x' }), record);
    expect(JSON.stringify(record.mock.calls[0])).not.toContain('ghp_x');
  });
});
