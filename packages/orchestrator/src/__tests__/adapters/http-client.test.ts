/**
 * Unit tests for HttpOrchestratorClient.
 */

import { describe, expect, test } from 'bun:test';

import { HttpClientError, HttpOrchestratorClient } from '../../adapters/http-client.js';

interface FakeRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

function makeFetch(impl: (req: FakeRequest) => Response | Promise<Response>): {
  fetch: typeof fetch;
  calls: FakeRequest[];
} {
  const calls: FakeRequest[] = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.toString();
    const req: FakeRequest = {
      url,
      method: (init?.method ?? 'GET').toUpperCase(),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: typeof init?.body === 'string' ? init.body : null,
    };
    calls.push(req);
    return impl(req);
  };
  return { fetch: fakeFetch, calls };
}

describe('HttpOrchestratorClient', () => {
  test('GET request includes auth header and parses JSON', async () => {
    const { fetch, calls } = makeFetch(
      () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    const client = new HttpOrchestratorClient({
      baseUrl: 'http://server:3001',
      authSecret: 'secret-xyz',
      fetch,
    });

    const result = await client.get<{ ok: boolean }>('/runs');
    expect(result).toEqual({ ok: true });
    expect(calls[0].url).toBe('http://server:3001/api/orchestrator/system/runs');
    expect(calls[0].headers['x-orchestrator-auth']).toBe('secret-xyz');
  });

  test('GET with query serializes parameters', async () => {
    const { fetch, calls } = makeFetch(() => new Response('{}', { status: 200 }));
    const client = new HttpOrchestratorClient({
      baseUrl: 'http://server:3001',
      authSecret: 's',
      fetch,
    });

    await client.get('/runs/due-retries', { now: 12345 });
    expect(calls[0].url).toBe(
      'http://server:3001/api/orchestrator/system/runs/due-retries?now=12345',
    );
  });

  test('POST sends JSON body', async () => {
    const { fetch, calls } = makeFetch(() => new Response('{}', { status: 200 }));
    const client = new HttpOrchestratorClient({
      baseUrl: 'http://server:3001',
      authSecret: 's',
      fetch,
    });

    await client.post('/runs', { threadId: 't1', userId: 'u1' });
    expect(calls[0].method).toBe('POST');
    expect(calls[0].body).toBe(JSON.stringify({ threadId: 't1', userId: 'u1' }));
    expect(calls[0].headers['content-type']).toBe('application/json');
  });

  test('non-2xx response throws HttpClientError with status + body', async () => {
    const { fetch } = makeFetch(() => new Response('{"error":"already exists"}', { status: 409 }));
    const client = new HttpOrchestratorClient({
      baseUrl: 'http://server:3001',
      authSecret: 's',
      fetch,
    });

    let caught: unknown;
    try {
      await client.post('/runs', {});
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(HttpClientError);
    if (caught instanceof HttpClientError) {
      expect(caught.status).toBe(409);
      expect(caught.body).toBe('{"error":"already exists"}');
    }
  });

  test('204 returns undefined', async () => {
    const { fetch } = makeFetch(() => new Response(null, { status: 204 }));
    const client = new HttpOrchestratorClient({
      baseUrl: 'http://server:3001',
      authSecret: 's',
      fetch,
    });

    const result = await client.del('/runs/abc');
    expect(result).toBeUndefined();
  });

  test('strips trailing slashes from baseUrl', async () => {
    const { fetch, calls } = makeFetch(() => new Response('{}', { status: 200 }));
    const client = new HttpOrchestratorClient({
      baseUrl: 'http://server:3001/',
      authSecret: 's',
      fetch,
    });

    await client.get('/runs');
    expect(calls[0].url).toBe('http://server:3001/api/orchestrator/system/runs');
  });
});
