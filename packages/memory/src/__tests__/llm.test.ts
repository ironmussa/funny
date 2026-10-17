import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { llmComplete, llmHealthCheck } from '../llm.js';
import type { LLMConfig } from '../types.js';

describe('llm', () => {
  const baseConfig: LLMConfig = {
    baseUrl: 'http://localhost:8317/v1',
    model: 'test-model',
  };

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
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

      vi.mocked(fetch).mockResolvedValueOnce(
        new Response(JSON.stringify(mockResponse), { status: 200 }),
      );

      const result = await llmComplete(baseConfig, 'test prompt', 'system prompt');
      expect(result).toBe('Hello from LLM');

      expect(fetch).toHaveBeenCalledOnce();
      const call = vi.mocked(fetch).mock.calls[0];
      expect(call[0]).toBe('http://localhost:8317/v1/chat/completions');

      const body = JSON.parse(call[1]!.body as string);
      expect(body.model).toBe('test-model');
      expect(body.messages).toEqual([
        { role: 'system', content: 'system prompt' },
        { role: 'user', content: 'test prompt' },
      ]);
      expect(body.stream).toBe(false);
    });

    it('includes Authorization header when apiKey is set', async () => {
      const config: LLMConfig = { ...baseConfig, apiKey: 'test-key-123' };

      vi.mocked(fetch).mockResolvedValueOnce(
        new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
          status: 200,
        }),
      );

      await llmComplete(config, 'prompt');

      const headers = vi.mocked(fetch).mock.calls[0][1]!.headers as Record<string, string>;
      expect(headers['Authorization']).toBe('Bearer test-key-123');
    });

    it('does not include Authorization when no apiKey', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
          status: 200,
        }),
      );

      await llmComplete(baseConfig, 'prompt');

      const headers = vi.mocked(fetch).mock.calls[0][1]!.headers as Record<string, string>;
      expect(headers['Authorization']).toBeUndefined();
    });

    it('sends only a user message when no system prompt is provided', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
          status: 200,
        }),
      );

      await llmComplete(baseConfig, 'prompt');

      const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
      expect(body.messages).toEqual([{ role: 'user', content: 'prompt' }]);
    });

    it('throws on HTTP error', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response('Internal Server Error', { status: 500 }),
      );

      await expect(llmComplete(baseConfig, 'prompt')).rejects.toThrow('LLM request failed (500)');
    });

    it('throws on API error response', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(
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
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response(JSON.stringify({ choices: [] }), { status: 200 }),
      );

      await expect(llmComplete(baseConfig, 'prompt')).rejects.toThrow('empty result');
    });

    it('strips trailing slash from baseUrl', async () => {
      const config: LLMConfig = { baseUrl: 'http://localhost:8317/v1/', model: 'test' };

      vi.mocked(fetch).mockResolvedValueOnce(
        new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
          status: 200,
        }),
      );

      await llmComplete(config, 'prompt');

      expect(vi.mocked(fetch).mock.calls[0][0]).toBe('http://localhost:8317/v1/chat/completions');
    });

    it('defaults model to claude-haiku', async () => {
      const config: LLMConfig = { baseUrl: 'http://localhost:8317/v1' };

      vi.mocked(fetch).mockResolvedValueOnce(
        new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
          status: 200,
        }),
      );

      await llmComplete(config, 'prompt');

      const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
      expect(body.model).toBe('claude-haiku');
    });
  });

  // ─── llmHealthCheck ─────────────────────────────────

  describe('llmHealthCheck', () => {
    it('returns true when server responds OK', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(new Response('{}', { status: 200 }));
      const result = await llmHealthCheck(baseConfig);
      expect(result).toBe(true);
    });

    it('calls /v1/models endpoint', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(new Response('{}', { status: 200 }));
      await llmHealthCheck(baseConfig);
      expect(vi.mocked(fetch).mock.calls[0][0]).toBe('http://localhost:8317/v1/models');
    });

    it('authenticates the models health check', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(new Response('{}', { status: 200 }));
      await llmHealthCheck({ ...baseConfig, apiKey: 'client-key' });
      expect(vi.mocked(fetch).mock.calls[0][1]?.headers).toEqual({
        Authorization: 'Bearer client-key',
      });
    });

    it('returns false on non-OK response', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(new Response('', { status: 503 }));
      const result = await llmHealthCheck(baseConfig);
      expect(result).toBe(false);
    });

    it('returns false on network error', async () => {
      vi.mocked(fetch).mockRejectedValueOnce(new Error('Connection refused'));
      const result = await llmHealthCheck(baseConfig);
      expect(result).toBe(false);
    });
  });
});
