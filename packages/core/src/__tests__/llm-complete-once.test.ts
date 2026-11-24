import { afterAll, beforeEach, describe, expect, it } from 'bun:test';

import { completeOnce } from '../agents/llm/complete.js';
import { ModelFactory } from '../agents/llm/model-factory.js';

interface Seen {
  path: string;
  authorization: string | null;
  body: any;
}

let seen: Seen[] = [];
let respond: (req: Request) => Response | Promise<Response> = () => new Response('unset');
let requestCancelled: Promise<void> = Promise.resolve();

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    seen.push({
      path: new URL(req.url).pathname,
      authorization: req.headers.get('authorization'),
      body: await req.json(),
    });
    return respond(req);
  },
});
afterAll(() => server.stop(true));

const baseURL = `http://127.0.0.1:${server.port}/v1`;
const base = { system: 'be brief', prompt: 'hello' };

beforeEach(() => {
  seen = [];
});

describe('completeOnce', () => {
  it('sends one tool-less completion and answers the assistant text', async () => {
    respond = () =>
      Response.json({ choices: [{ message: { role: 'assistant', content: 'hi there' } }] });
    const result = await completeOnce({
      ...base,
      provider: 'openai',
      model: 'gpt-4o',
      apiKey: 'user-key',
      modelFactory: new ModelFactory({ openai: { baseURL } }),
    });
    expect(result._unsafeUnwrap()).toBe('hi there');
    expect(seen).toHaveLength(1);
    expect(seen[0].path).toBe('/v1/chat/completions');
    expect(seen[0].authorization).toBe('Bearer user-key');
    expect(seen[0].body).toEqual({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: 'be brief' },
        { role: 'user', content: 'hello' },
      ],
      stream: false,
    });
    expect(seen[0].body.tools).toBeUndefined();
  });

  it('answers a non-2xx provider response as an err, without the key', async () => {
    respond = () => new Response('model overloaded', { status: 503 });
    const result = await completeOnce({
      ...base,
      provider: 'openai-compatible',
      model: 'llama3',
      apiKey: 'secret-key',
      baseURL,
    });
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error).toMatchObject({ kind: 'provider-error', status: 503 });
    expect(JSON.stringify(error)).not.toContain('secret-key');
  });

  it('cancels the fetch on abort and answers an err', async () => {
    const cancelled = Promise.withResolvers<void>();
    requestCancelled = cancelled.promise;
    respond = (req) =>
      new Promise<Response>((resolve) => {
        req.signal.addEventListener('abort', () => {
          cancelled.resolve();
          resolve(new Response('late'));
        });
      });
    const controller = new AbortController();
    const pending = completeOnce({
      ...base,
      provider: 'ollama',
      model: 'llama3',
      baseURL,
      signal: controller.signal,
    });
    while (seen.length === 0) await Bun.sleep(5);
    controller.abort(new Error('stop'));
    const result = await pending;
    expect(result._unsafeUnwrapErr()).toEqual({ kind: 'aborted', message: 'stop' });
    await requestCancelled;
  });

  it.each(['openai', 'anthropic'])(
    'refuses %s without a key and never falls back to the environment',
    async (provider) => {
      const envVar = provider === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY';
      const previous = process.env[envVar];
      process.env[envVar] = 'env-key';
      try {
        const result = await completeOnce({
          ...base,
          provider,
          model: 'm',
          modelFactory: new ModelFactory({ openai: { baseURL }, anthropic: { baseURL } }),
        });
        expect(result._unsafeUnwrapErr()).toEqual({ kind: 'missing-credentials', provider });
        expect(seen).toHaveLength(0);
      } finally {
        if (previous === undefined) delete process.env[envVar];
        else process.env[envVar] = previous;
      }
    },
  );
});
