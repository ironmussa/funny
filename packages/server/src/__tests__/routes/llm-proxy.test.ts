import { describe, expect, test } from 'bun:test';

import { okAsync } from 'neverthrow';

import { createLlmProxyRoutes } from '../../routes/llm-proxy.js';
import {
  anthropicUpstreamHeaders,
  isAllowedAnthropicPath,
} from '../../services/llm-proxy/anthropic-adapter.js';

const OAUTH = 'sk-ant-oat01-subscription';

function setup(opts: { credential?: string | null } = {}) {
  const calls: Array<{ url: string; init: RequestInit; body: string }> = [];
  const routes = createLlmProxyRoutes({
    resolveToken: (token) =>
      okAsync(token === 'llmp_good' ? { userId: 'alice', threadId: 't-1' } : null),
    credentialFor: async (userId, keyId) =>
      userId === 'alice' && keyId === 'claude-subscription'
        ? opts.credential === undefined
          ? OAUTH
          : opts.credential
        : null,
    upstream: 'https://anthropic.test',
    fetch: (async (url: string, init: RequestInit) => {
      const body = init.body ? await new Response(init.body).text() : '';
      calls.push({ url, init, body });
      return new Response('event: message_start\ndata: {}\n\n', {
        status: 200,
        headers: {
          'content-type': 'text/event-stream',
          'content-encoding': 'gzip',
          'request-id': 'req_1',
        },
      });
    }) as unknown as typeof fetch,
  });
  const request = (path: string, headers: Record<string, string>, body = '{"model":"x"}') =>
    routes.request(`/anthropic${path}`, { method: 'POST', headers, body });
  return { calls, request };
}

describe('LLM proxy — Anthropic', () => {
  test('swaps the sandbox token for the subscription token and streams the answer back', async () => {
    const { calls, request } = setup();
    const res = await request('/v1/messages?beta=true', {
      authorization: 'Bearer llmp_good',
      'anthropic-beta': 'fine-grained-tool-streaming-2025-05-14',
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
      cookie: 'session=leak',
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    expect(res.headers.get('content-encoding')).toBeNull();
    expect(await res.text()).toContain('message_start');

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://anthropic.test/v1/messages?beta=true');
    expect(calls[0].body).toBe('{"model":"x"}');
    const sent = new Headers(calls[0].init.headers);
    expect(sent.get('authorization')).toBe(`Bearer ${OAUTH}`);
    expect(sent.get('anthropic-beta')).toBe(
      'fine-grained-tool-streaming-2025-05-14,oauth-2025-04-20',
    );
    expect(sent.get('anthropic-version')).toBe('2023-06-01');
    expect(sent.get('cookie')).toBeNull();
    expect(sent.get('x-api-key')).toBeNull();
  });

  test('accepts the sandbox token as x-api-key too', async () => {
    const { request } = setup();
    expect((await request('/v1/messages', { 'x-api-key': 'llmp_good' })).status).toBe(200);
  });

  test('an unknown or revoked token never reaches Anthropic', async () => {
    const { calls, request } = setup();
    const res = await request('/v1/messages', { authorization: 'Bearer llmp_revoked' });
    expect(res.status).toBe(401);
    expect((await res.json()).error.type).toBe('authentication_error');
    expect((await request('/v1/messages', {})).status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  test('only model endpoints are reachable', async () => {
    const { calls, request } = setup();
    const res = await request('/v1/organizations/me', { authorization: 'Bearer llmp_good' });
    expect(res.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  test('without a stored credential the agent is told how to add one', async () => {
    const { calls, request } = setup({ credential: null });
    const res = await request('/v1/messages', { authorization: 'Bearer llmp_good' });
    expect(res.status).toBe(401);
    expect((await res.json()).error.message).toContain('claude setup-token');
    expect(calls).toHaveLength(0);
  });

  test('an API key is sent as x-api-key, without the OAuth beta', () => {
    const headers = anthropicUpstreamHeaders(
      new Headers({ authorization: 'Bearer llmp_good' }),
      'sk-ant-api03-key',
    );
    expect(headers.get('x-api-key')).toBe('sk-ant-api03-key');
    expect(headers.get('authorization')).toBeNull();
    expect(headers.get('anthropic-beta')).toBeNull();
  });

  test('path allow-list', () => {
    expect(isAllowedAnthropicPath('/v1/messages')).toBe(true);
    expect(isAllowedAnthropicPath('/v1/messages/count_tokens')).toBe(true);
    expect(isAllowedAnthropicPath('/v1/models')).toBe(true);
    expect(isAllowedAnthropicPath('/v1/models/claude-opus-5-5')).toBe(true);
    expect(isAllowedAnthropicPath('/v1/messages/batches')).toBe(false);
    expect(isAllowedAnthropicPath('/v1/files')).toBe(false);
    expect(isAllowedAnthropicPath('/../v1/messages')).toBe(false);
  });
});

describe('LLM proxy — per-sandbox limit', () => {
  test('one sandbox over its limit gets 429 while another sandbox is still served', async () => {
    const routes = createLlmProxyRoutes({
      resolveToken: (token) =>
        okAsync(
          token === 'llmp_a'
            ? { userId: 'alice', threadId: 't-a' }
            : token === 'llmp_b'
              ? { userId: 'alice', threadId: 't-b' }
              : null,
        ),
      credentialFor: async () => OAUTH,
      upstream: 'https://anthropic.test',
      fetch: (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch,
      perSandboxLimit: { windowMs: 60_000, max: 2 },
    });
    const send = (token: string) =>
      routes.request('/anthropic/v1/messages', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
        body: '{}',
      });

    expect((await send('llmp_a')).status).toBe(200);
    expect((await send('llmp_a')).status).toBe(200);
    const limited = await send('llmp_a');
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('60');
    expect(((await limited.json()) as { error: { type: string } }).error.type).toBe(
      'rate_limit_error',
    );
    expect((await send('llmp_b')).status).toBe(200);
    // Invalid tokens are refused before they touch any sandbox's budget.
    expect((await send('llmp_bad')).status).toBe(401);
  });
});
