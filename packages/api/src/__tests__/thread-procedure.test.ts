import { describe, expect, test } from 'bun:test';

import type { Thread } from '@funny/shared';
import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import { z } from 'zod';

import type { ApiPorts, ThreadAccessLevel } from '../ports.js';
import { router, threadProcedure } from '../trpc.js';

const thread = { id: 't1', userId: 'owner' } as Thread;

const testRouter = router({
  rename: threadProcedure('owner')
    .input(z.object({ id: z.string(), title: z.string().min(1, 'title required') }))
    .mutation(({ ctx, input }) => ({ thread: ctx.thread.id, title: input.title })),
  read: threadProcedure('view')
    .input(z.object({ id: z.string() }))
    .query(({ ctx }) => ctx.thread.id),
});

function setup() {
  const calls: Array<[ThreadAccessLevel, string, string]> = [];
  const ports = {
    threadAccess: {
      authorize: async (level: ThreadAccessLevel, threadId: string, userId: string) => {
        calls.push([level, threadId, userId]);
        return threadId === 't1' && userId === 'owner' ? thread : null;
      },
    },
  } as unknown as ApiPorts;

  const call = async (userId: string | null, path: string, input: unknown, method = 'POST') => {
    const qs = method === 'GET' ? `?input=${encodeURIComponent(JSON.stringify(input))}` : '';
    const res = await fetchRequestHandler({
      endpoint: '/trpc',
      router: testRouter,
      req: new Request(`http://x/trpc/${path}${qs}`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: method === 'POST' ? JSON.stringify(input) : undefined,
      }),
      createContext: () => ({ userId, organizationId: null, ports }),
    });
    return { status: res.status, body: (await res.json()) as any };
  };
  return { call, calls };
}

describe('threadProcedure', () => {
  test('authorized: the handler gets ctx.thread, and the level is passed to the port', async () => {
    const { call, calls } = setup();
    const res = await call('owner', 'rename', { id: 't1', title: 'New' });
    expect(res.status).toBe(200);
    expect(res.body.result.data).toEqual({ thread: 't1', title: 'New' });
    expect(calls).toEqual([['owner', 't1', 'owner']]);

    await call('owner', 'read', { id: 't1' }, 'GET');
    expect(calls.at(-1)).toEqual(['view', 't1', 'owner']);
  });

  test('another user’s thread answers 404 Thread not found', async () => {
    const res = await setup().call('intruder', 'rename', { id: 't1', title: 'x' });
    expect(res.status).toBe(404);
    expect(res.body.error.message).toBe('Thread not found');
  });

  test('a missing thread looks the same as an inaccessible one', async () => {
    const res = await setup().call('owner', 'rename', { id: 'nope', title: 'x' });
    expect(res.status).toBe(404);
    expect(res.body.error.message).toBe('Thread not found');
  });

  test('404 wins over invalid input', async () => {
    const res = await setup().call('intruder', 'rename', { id: 't1', title: '' });
    expect(res.status).toBe(404);
  });

  test('an authorized caller with invalid input gets 400', async () => {
    const res = await setup().call('owner', 'rename', { id: 't1', title: '' });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('title required');
  });

  test('input without a thread id answers 404 without asking the port', async () => {
    const { call, calls } = setup();
    const res = await call('owner', 'rename', { title: 'x' });
    expect(res.status).toBe(404);
    expect(calls).toEqual([]);
  });

  test('no user answers 401 before the thread is looked up', async () => {
    const { call, calls } = setup();
    const res = await call(null, 'rename', { id: 't1', title: 'x' });
    expect(res.status).toBe(401);
    expect(calls).toEqual([]);
  });
});
