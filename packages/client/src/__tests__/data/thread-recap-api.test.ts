import { describe, expect, test, vi, mock } from 'bun:test';

import { okAsync } from 'neverthrow';

const requestInThread = vi.fn(() => okAsync({ recap: 'r', newestMessageId: 'm1' }));
const actual = await import('@/lib/api/_core');
mock.module('@/lib/api/_core', () => ({ ...actual, requestInThread }));

import { threadRecapApi } from '@/data/thread-recap/api';

describe('threadRecapApi', () => {
  test('posts { since, newestMessageId, language } in the open thread context', async () => {
    const body = { since: '2026-11-24T11:00:00.000Z', newestMessageId: 'm1', language: 'es' };
    const result = await threadRecapApi.generate('t 1', body);

    expect(result._unsafeUnwrap()).toEqual({ recap: 'r', newestMessageId: 'm1' });
    expect(requestInThread).toHaveBeenCalledWith('/threads/t%201/recap', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  });
});
