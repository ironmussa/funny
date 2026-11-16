/**
 * The message route notes a follow-up for a factory run's take-over only when
 * the thread's OWNER sent it and the runner accepted it: a steer sharee's
 * follow-up, one on a non-factory thread, and a refused one are not noted.
 */
import { mockCoreGitRepoChecks } from '../helpers/module-mocks.js';

process.env.RUNNER_AUTH_SECRET = 'test-secret';

mockCoreGitRepoChecks();

import { describe, expect, test } from 'bun:test';

import { Hono } from 'hono';

import type { ServerEnv } from '../../lib/types.js';
import { noteFactoryOwnerFollowUp } from '../../routes/threads.js';
import {
  forgetOwnerFollowUp,
  ownerFollowUpAt,
} from '../../services/factory/factory-follow-ups.js';

function send(opts: { caller: string; source: string; runnerStatus: number }) {
  const app = new Hono<ServerEnv>();
  app.post(
    '/api/threads/:id/message',
    async (c, next) => {
      c.set('userId', opts.caller);
      c.set('thread', { id: 't1', userId: 'alice', source: opts.source } as never);
      await next();
    },
    noteFactoryOwnerFollowUp,
    (c) => c.json({}, opts.runnerStatus as 200),
  );
  return app.request('/api/threads/t1/message', { method: 'POST' });
}

describe('factory follow-up note', () => {
  test("the owner's accepted follow-up on a factory thread is noted", async () => {
    forgetOwnerFollowUp('t1');
    await send({ caller: 'alice', source: 'factory', runnerStatus: 200 });
    expect(ownerFollowUpAt('t1')).toBeNumber();
  });

  test("a steer sharee's follow-up is not noted", async () => {
    forgetOwnerFollowUp('t1');
    await send({ caller: 'bob', source: 'factory', runnerStatus: 200 });
    expect(ownerFollowUpAt('t1')).toBeUndefined();
  });

  test('a refused follow-up, or one on a thread the factory did not start, is not noted', async () => {
    forgetOwnerFollowUp('t1');
    await send({ caller: 'alice', source: 'factory', runnerStatus: 502 });
    await send({ caller: 'alice', source: 'web', runnerStatus: 200 });
    expect(ownerFollowUpAt('t1')).toBeUndefined();
  });
});
