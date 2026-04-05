import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { llmComplete, llmHealthCheck, type LLMConfig } from '../llm.js';

describe('llm', () => {
  const baseConfig: LLMConfig = {
    baseUrl: 'http://localhost:4010',
    model: 'test-model',
  };

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ─── llmComplete ────────────────────────────────────

  describe('llmComplete', () => {
    it('sends correct request to /v1/runs', async () => {
      const mockResponse = {
        id: 'run-1',
        status: 'completed',
        result: { text: 'Hello from LLM' },
        usage: { input_tokens: 10, output_tokens: 5 },
      };

      vi.mocked(fetch).mockResolvedValueOnce(
        new Response(JSON.stringify(mockResponse), { status: 200 }),
      );

      const result = await llmComplete(baseConfig, 'test prompt', 'system prompt');
      expect(result).toBe('Hello from LLM');

      expect(fetch).toHaveBeenCalledOnce();
      const call = vi.mocked(fetch).mock.calls[0];
      expect(call[0]).toBe('http://localhost:4010/v1/runs');

      const body = JSON.parse(call[1]!.body as string);
      expect(body.model).toBe('test-model');
      expect(body.prompt).toBe('test prompt');
      expect(body.system_prompt).toBe('system prompt');
      expect(body.max_turns).toBe(1);
    });

    it('includes Authorization header when apiKey is set', async () => {
      const config: LLMConfig = { ...baseConfig, apiKey: 'test-key-123' };

      vi.mocked(fetch).mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 'r', status: 'completed', result: { text: 'ok' } }), {
          status: 200,
        }),
      );

      await llmComplete(config, 'prompt');

      const headers = vi.mocked(fetch).mock.calls[0][1]!.headers as Record<string, string>;
      expect(headers['Authorization']).toBe('Bearer test-key-123');
    });

    it('does not include Authorization when no apiKey', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 'r', status: 'completed', result: { text: 'ok' } }), {
          status: 200,
        }),
      );

      await llmComplete(baseConfig, 'prompt');

      const headers = vi.mocked(fetch).mock.calls[0][1]!.headers as Record<string, string>;
      expect(headers['Authorization']).toBeUndefined();
    });

    it('does not send system_prompt when not provided', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 'r', status: 'completed', result: { text: 'ok' } }), {
          status: 200,
        }),
      );

      await llmComplete(baseConfig, 'prompt');

      const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
      expect(body.system_prompt).toBeUndefined();
    });

    it('throws on HTTP error', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response('Internal Server Error', { status: 500 }),
      );

      await expect(llmComplete(baseConfig, 'prompt')).rejects.toThrow('LLM request failed (500)');
    });

    it('throws on failed run status', async () => {
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
        new Response(JSON.stringify({ id: 'r', status: 'completed', result: {} }), { status: 200 }),
      );

      await expect(llmComplete(baseConfig, 'prompt')).rejects.toThrow('empty result');
    });

    it('strips trailing slash from baseUrl', async () => {
      const config: LLMConfig = { baseUrl: 'http://localhost:4010/', model: 'test' };

      vi.mocked(fetch).mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 'r', status: 'completed', result: { text: 'ok' } }), {
          status: 200,
        }),
      );

      await llmComplete(config, 'prompt');

      expect(vi.mocked(fetch).mock.calls[0][0]).toBe('http://localhost:4010/v1/runs');
    });

    it('defaults model to claude-haiku', async () => {
      const config: LLMConfig = { baseUrl: 'http://localhost:4010' };

      vi.mocked(fetch).mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 'r', status: 'completed', result: { text: 'ok' } }), {
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
      expect(vi.mocked(fetch).mock.calls[0][0]).toBe('http://localhost:4010/v1/models');
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
