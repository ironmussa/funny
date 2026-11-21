import { describe, it, expect, vi, beforeEach, afterEach } from 'bun:test';

import { mocked, stubGlobal, unstubAllGlobals } from '@funny/test-kit';

import { llmComplete, llmHealthCheck } from '../llm.js';
import type { LLMConfig } from '../types.js';

describe('llm', () => {
  const baseConfig: LLMConfig = {
    baseUrl: 'http://localhost:8317/v1',
    model: 'test-model',
  };

  beforeEach(() => {
    stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    unstubAllGlobals();
  });

  // ─── llmComplete ────────────────────────────────────

  describe('llmComplete', () => {
    it('sends correct request to /v1/chat/completions', async () => {
      const mockResponse = {
        id: 'run-1',
        status: 'completed',
        choices: [{ message: { content: 'Hello from LLM' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      };

      mocked(fetch).mockResolvedValueOnce(
        new Response(JSON.stringify(mockResponse), { status: 200 }),
      );

      const result = await llmComplete(baseConfig, 'test prompt', 'system prompt');
      expect(result).toBe('Hello from LLM');

      expect(fetch).toHaveBeenCalledTimes(1);
      const call = mocked(fetch).mock.calls[0];
      expect(call[0]).toBe('http://localhost:8317/v1/chat/completions');

      const body = JSON.parse(String(call[1]?.body));
      expect(body.model).toBe('test-model');
      expect(body.messages).toEqual([
        { role: 'system', content: 'system prompt' },
        { role: 'user', content: 'test prompt' },
      ]);
      expect(body.stream).toBe(false);
    });

    it('includes Authorization header when apiKey is set', async () => {
      const config: LLMConfig = { ...baseConfig, apiKey: 'test-key-123' };

      mocked(fetch).mockResolvedValueOnce(
        new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
          status: 200,
        }),
      );

      await llmComplete(config, 'prompt');

      const headers = new Headers(mocked(fetch).mock.calls[0][1]?.headers);
      expect(headers.get('Authorization')).toBe('Bearer test-key-123');
    });

    it('does not include Authorization when no apiKey', async () => {
      mocked(fetch).mockResolvedValueOnce(
        new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
          status: 200,
        }),
      );

      await llmComplete(baseConfig, 'prompt');

      const headers = new Headers(mocked(fetch).mock.calls[0][1]?.headers);
      expect(headers.get('Authorization')).toBeNull();
    });

    it('sends only a user message when no system prompt is provided', async () => {
      mocked(fetch).mockResolvedValueOnce(
        new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
          status: 200,
        }),
      );

      await llmComplete(baseConfig, 'prompt');

      const body = JSON.parse(String(mocked(fetch).mock.calls[0][1]?.body));
      expect(body.messages).toEqual([{ role: 'user', content: 'prompt' }]);
    });

    it('throws on HTTP error', async () => {
      mocked(fetch).mockResolvedValueOnce(new Response('Internal Server Error', { status: 500 }));

      await expect(llmComplete(baseConfig, 'prompt')).rejects.toThrow('LLM request failed (500)');
    });

    it('throws on API error response', async () => {
      mocked(fetch).mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 'r',
            status: 'failed',
            error: { message: 'Rate limited' },
          }),
          { status: 200 },
        ),
      );

      await expect(llmComplete(baseConfig, 'prompt')).rejects.toThrow('Rate limited');
    });

    it('throws on empty result', async () => {
      mocked(fetch).mockResolvedValueOnce(
        new Response(JSON.stringify({ choices: [] }), { status: 200 }),
      );

      await expect(llmComplete(baseConfig, 'prompt')).rejects.toThrow('empty result');
    });

    it('strips trailing slash from baseUrl', async () => {
      const config: LLMConfig = { baseUrl: 'http://localhost:8317/v1/', model: 'test' };

      mocked(fetch).mockResolvedValueOnce(
        new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
          status: 200,
        }),
      );

      await llmComplete(config, 'prompt');

      expect(mocked(fetch).mock.calls[0][0]).toBe('http://localhost:8317/v1/chat/completions');
    });

    it('defaults model to claude-haiku', async () => {
      const config: LLMConfig = { baseUrl: 'http://localhost:8317/v1' };

      mocked(fetch).mockResolvedValueOnce(
        new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
          status: 200,
        }),
      );

      await llmComplete(config, 'prompt');

      const body = JSON.parse(String(mocked(fetch).mock.calls[0][1]?.body));
      expect(body.model).toBe('claude-haiku');
    });
  });

  // ─── llmHealthCheck ─────────────────────────────────

  describe('llmHealthCheck', () => {
    it('returns true when server responds OK', async () => {
      mocked(fetch).mockResolvedValueOnce(new Response('{}', { status: 200 }));
      const result = await llmHealthCheck(baseConfig);
      expect(result).toBe(true);
    });

    it('calls /v1/models endpoint', async () => {
      mocked(fetch).mockResolvedValueOnce(new Response('{}', { status: 200 }));
      await llmHealthCheck(baseConfig);
      expect(mocked(fetch).mock.calls[0][0]).toBe('http://localhost:8317/v1/models');
    });

    it('authenticates the models health check', async () => {
      mocked(fetch).mockResolvedValueOnce(new Response('{}', { status: 200 }));
      await llmHealthCheck({ ...baseConfig, apiKey: 'client-key' });
      expect(mocked(fetch).mock.calls[0][1]?.headers).toEqual({
        Authorization: 'Bearer client-key',
      });
    });

    it('returns false on non-OK response', async () => {
      mocked(fetch).mockResolvedValueOnce(new Response('', { status: 503 }));
      const result = await llmHealthCheck(baseConfig);
      expect(result).toBe(false);
    });

    it('returns false on network error', async () => {
      mocked(fetch).mockRejectedValueOnce(new Error('Connection refused'));
      const result = await llmHealthCheck(baseConfig);
      expect(result).toBe(false);
    });
  });
});
