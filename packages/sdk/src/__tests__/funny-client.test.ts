/**
 * Unit tests for FunnyClient ingest webhook client.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { FunnyClient, FunnyClientError } from '../funny-client.js';

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
  const fakeFetch = (async (input, init) => {
    const url = typeof input === 'string' ? input : input.toString();
    const req: FakeRequest = {
      url,
      method: (init?.method ?? 'GET').toUpperCase(),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: typeof init?.body === 'string' ? init.body : null,
    };
    calls.push(req);
    return impl(req);
  }) as typeof fetch;
  return { fetch: fakeFetch, calls };
}

describe('FunnyClient', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('strips trailing slashes from baseUrl', async () => {
    const { fetch, calls } = makeFetch(
      () => new Response(JSON.stringify({ status: 'ok' }), { status: 200 }),
    );
    globalThis.fetch = fetch;

    const client = new FunnyClient({
      baseUrl: 'http://localhost:3001/',
      secret: 'secret',
    });
    await client.message('req-1', 'hello');

    expect(calls[0].url).toBe('http://localhost:3001/api/ingest/webhook');
  });

  test('send posts JSON with webhook secret header', async () => {
    const { fetch, calls } = makeFetch(
      () => new Response(JSON.stringify({ status: 'ok', thread_id: 't-1' }), { status: 200 }),
    );
    globalThis.fetch = fetch;

    const client = new FunnyClient({
      baseUrl: 'http://localhost:3001',
      secret: 'wh-secret',
    });
    const result = await client.accepted('req-1', {
      projectId: 'proj-1',
      prompt: 'Do the thing',
    });

    expect(result).toEqual({ status: 'ok', thread_id: 't-1' });
    expect(calls[0].method).toBe('POST');
    expect(calls[0].headers['content-type']).toBe('application/json');
    expect(calls[0].headers['x-webhook-secret']).toBe('wh-secret');

    const body = JSON.parse(calls[0].body ?? '{}') as Record<string, unknown>;
    expect(body.event_type).toBe('pipeline.accepted');
    expect(body.request_id).toBe('req-1');
    expect(body.data).toEqual({
      projectId: 'proj-1',
      prompt: 'Do the thing',
    });
    expect(typeof body.timestamp).toBe('string');
  });

  test('non-2xx response throws FunnyClientError with status code', async () => {
    const { fetch } = makeFetch(
      () => new Response(JSON.stringify({ error: 'invalid secret' }), { status: 401 }),
    );
    globalThis.fetch = fetch;

    const client = new FunnyClient({
      baseUrl: 'http://localhost:3001',
      secret: 'bad',
    });

    let caught: unknown;
    try {
      await client.started('req-1');
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(FunnyClientError);
    if (caught instanceof FunnyClientError) {
      expect(caught.statusCode).toBe(401);
      expect(caught.message).toBe('invalid secret');
    }
  });

  test('message sends pipeline.message with content', async () => {
    const { fetch, calls } = makeFetch(
      () => new Response(JSON.stringify({ status: 'ok' }), { status: 200 }),
    );
    globalThis.fetch = fetch;

    const client = new FunnyClient({
      baseUrl: 'http://localhost:3001',
      secret: 's',
    });
    await client.message('req-2', 'Step done', { threadId: 'thread-9' });

    const body = JSON.parse(calls[0].body ?? '{}') as Record<string, unknown>;
    expect(body.event_type).toBe('pipeline.message');
    expect(body.thread_id).toBe('thread-9');
    expect(body.data).toEqual({ content: 'Step done' });
  });

  test('cliText wraps assistant message payload', async () => {
    const { fetch, calls } = makeFetch(
      () => new Response(JSON.stringify({ status: 'ok' }), { status: 200 }),
    );
    globalThis.fetch = fetch;

    const client = new FunnyClient({
      baseUrl: 'http://localhost:3001',
      secret: 's',
    });
    await client.cliText('req-3', 'msg-1', 'Working...');

    const body = JSON.parse(calls[0].body ?? '{}') as {
      event_type: string;
      data: { cli_message: Record<string, unknown> };
    };
    expect(body.event_type).toBe('pipeline.cli_message');
    expect(body.data.cli_message).toEqual({
      type: 'assistant',
      message: {
        id: 'msg-1',
        content: [{ type: 'text', text: 'Working...' }],
      },
    });
  });

  test('emit sends arbitrary event types', async () => {
    const { fetch, calls } = makeFetch(
      () => new Response(JSON.stringify({ status: 'ok' }), { status: 200 }),
    );
    globalThis.fetch = fetch;

    const client = new FunnyClient({
      baseUrl: 'http://localhost:3001',
      secret: 's',
    });
    await client.emit('workflow.started', 'req-4', { step: 1 }, { threadId: 't-4' });

    const body = JSON.parse(calls[0].body ?? '{}') as Record<string, unknown>;
    expect(body.event_type).toBe('workflow.started');
    expect(body.thread_id).toBe('t-4');
    expect(body.data).toEqual({ step: 1 });
  });
});
