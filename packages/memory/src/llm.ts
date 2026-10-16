import { runAsync } from '@funny/shared/async';
/**
 * @domain subdomain: Memory System (Paisley Park)
 * @domain type: infrastructure-service
 * @domain layer: infrastructure
 *
 * LLM client for consolidation tasks.
 * Makes plain HTTP calls to an api-acp server (or any OpenAI-compatible endpoint).
 * No LLM SDK dependency — just fetch.
 */

import { log } from './logger.js';

// ─── Config ────────────────────────────────────────────

export interface LLMConfig {
  /** api-acp base URL (e.g. http://localhost:4010) */
  baseUrl: string;
  /** Model ID (default: claude-haiku) */
  model?: string;
  /** Optional API key */
  apiKey?: string;
  /** Request timeout in ms (default: 60000) */
  timeoutMs?: number;
}

// ─── Response types ────────────────────────────────────

interface RunResponse {
  id: string;
  status: 'completed' | 'failed' | 'cancelled';
  result?: { text: string };
  error?: { message: string };
  usage?: { input_tokens: number; output_tokens: number };
}

// ─── Main completion function ──────────────────────────

export async function llmComplete(
  config: LLMConfig,
  prompt: string,
  systemPrompt?: string,
): Promise<string> {
  const url = `${config.baseUrl.replace(/\/$/, '')}/v1/runs`;
  const model = config.model ?? 'claude-haiku';
  const timeout = config.timeoutMs ?? 60_000;

  const body: Record<string, unknown> = {
    model,
    prompt,
    max_turns: 1,
  };
  if (systemPrompt) {
    body.system_prompt = systemPrompt;
  }

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

      const run = (await resp.json()) as RunResponse;

      if (run.status === 'failed') {
        throw new Error(`LLM run failed: ${run.error?.message ?? 'unknown error'}`);
      }

      if (!run.result?.text) {
        throw new Error('LLM returned empty result');
      }

      log.debug('LLM call completed', {
        namespace: 'memory:llm',
        model,
        inputTokens: run.usage?.input_tokens,
        outputTokens: run.usage?.output_tokens,
      });

      return run.result.text;
    },
    { timeoutMs: timeout },
  );
}

// ─── Health check ──────────────────────────────────────

export async function llmHealthCheck(config: LLMConfig): Promise<boolean> {
  try {
    const resp = await runAsync(
      (signal) => fetch(`${config.baseUrl.replace(/\/$/, '')}/v1/models`, { signal }),
      { timeoutMs: 3000 },
    );
    return resp.ok;
  } catch {
    return false;
  }
}
