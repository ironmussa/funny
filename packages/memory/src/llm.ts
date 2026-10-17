import { runAsync } from '@funny/shared/async';
/**
 * @domain subdomain: Memory System (Paisley Park)
 * @domain type: infrastructure-service
 * @domain layer: infrastructure
 *
 * LLM client for consolidation tasks.
 * Makes plain HTTP calls to an OpenAI-compatible endpoint.
 * No LLM SDK dependency — just fetch.
 */

import { log } from './logger.js';

// ─── Config ────────────────────────────────────────────

export interface LLMConfig {
  /** API base URL including /v1 (e.g. http://localhost:8317/v1) */
  baseUrl: string;
  /** Model ID (default: claude-haiku) */
  model?: string;
  /** Optional API key */
  apiKey?: string;
  /** Request timeout in ms (default: 60000) */
  timeoutMs?: number;
}

// ─── Response types ────────────────────────────────────

interface ChatResponse {
  choices?: Array<{ message: { content: string | null } }>;
  error?: { message: string };
  usage?: { prompt_tokens: number; completion_tokens: number };
}

// ─── Main completion function ──────────────────────────

export async function llmComplete(
  config: LLMConfig,
  prompt: string,
  systemPrompt?: string,
): Promise<string> {
  const url = `${config.baseUrl.replace(/\/$/, '')}/chat/completions`;
  const model = config.model ?? 'claude-haiku';
  const timeout = config.timeoutMs ?? 60_000;

  const messages = [
    ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
    { role: 'user', content: prompt },
  ];
  const body = { model, messages, stream: false };

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (config.apiKey) {
    headers['Authorization'] = `Bearer ${config.apiKey}`;
  }

  log.debug(`LLM call to ${model}`, {
    namespace: 'memory:llm',
    promptLength: prompt.length,
  });

  return runAsync(
    async (signal) => {
      const resp = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal,
      });

      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        throw new Error(`LLM request failed (${resp.status}): ${text}`);
      }

      const run = (await resp.json()) as ChatResponse;

      if (run.error) {
        throw new Error(`LLM completion failed: ${run.error?.message ?? 'unknown error'}`);
      }

      if (!run.choices?.[0]?.message.content) {
        throw new Error('LLM returned empty result');
      }

      log.debug('LLM call completed', {
        namespace: 'memory:llm',
        model,
        inputTokens: run.usage?.prompt_tokens,
        outputTokens: run.usage?.completion_tokens,
      });

      return run.choices[0].message.content;
    },
    { timeoutMs: timeout },
  );
}

// ─── Health check ──────────────────────────────────────

export async function llmHealthCheck(config: LLMConfig): Promise<boolean> {
  try {
    const resp = await runAsync(
      (signal) =>
        fetch(`${config.baseUrl.replace(/\/$/, '')}/models`, {
          signal,
          headers: config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : undefined,
        }),
      { timeoutMs: 3000 },
    );
    return resp.ok;
  } catch {
    return false;
  }
}
