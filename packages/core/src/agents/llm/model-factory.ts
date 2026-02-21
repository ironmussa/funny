/**
 * Model Factory — creates Vercel AI SDK LanguageModel instances.
 *
 * Supports:
 *   - Anthropic (Claude) via @ai-sdk/anthropic
 *   - OpenAI (GPT) via @ai-sdk/openai
 *   - Ollama (local models) via @ai-sdk/openai with custom baseURL
 *   - Any OpenAI-compatible server (vLLM, LM Studio, etc.)
 */

import type { LanguageModel } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';

// ── Provider Config ───────────────────────────────────────────

export interface LLMProviderConfig {
  anthropic?: {
    apiKey?: string;
    baseURL?: string;
  };
  openai?: {
    apiKey?: string;
    baseURL?: string;
  };
  ollama?: {
    baseURL?: string;
  };
}

// ── Factory ───────────────────────────────────────────────────

export class ModelFactory {
  private config: LLMProviderConfig;

  constructor(config: LLMProviderConfig = {}) {
    this.config = config;
  }

  /**
   * Create a LanguageModel from a provider name and model ID.
   *
   * Examples:
   *   create('anthropic', 'claude-sonnet-4-5-20250929')
   *   create('openai', 'gpt-4-turbo')
   *   create('ollama', 'llama3:70b')
   *   create('openai-compatible', 'my-model', { baseURL: 'http://localhost:8000/v1' })
   */
  create(
    provider: string,
    modelId: string,
    overrides?: { apiKey?: string; baseURL?: string },
  ): LanguageModel {
    switch (provider) {
      case 'anthropic': {
        const anthropic = createAnthropic({
          apiKey: overrides?.apiKey ?? this.config.anthropic?.apiKey ?? process.env.ANTHROPIC_API_KEY,
          baseURL: overrides?.baseURL ?? this.config.anthropic?.baseURL,
        });
        return anthropic(modelId);
      }

      case 'openai': {
        const openai = createOpenAI({
          apiKey: overrides?.apiKey ?? this.config.openai?.apiKey ?? process.env.OPENAI_API_KEY,
          baseURL: overrides?.baseURL ?? this.config.openai?.baseURL,
        });
        return openai(modelId);
      }

      case 'ollama': {
        // Ollama exposes an OpenAI-compatible API at /v1
        const baseURL = overrides?.baseURL
          ?? this.config.ollama?.baseURL
          ?? process.env.OLLAMA_BASE_URL
          ?? 'http://localhost:11434/v1';

        const ollama = createOpenAI({
          baseURL,
          apiKey: 'ollama', // Ollama doesn't need a real key
        });
        return ollama(modelId);
      }

      case 'openai-compatible': {
        // Generic OpenAI-compatible server (vLLM, LM Studio, LocalAI, etc.)
        if (!overrides?.baseURL) {
          throw new Error('openai-compatible provider requires a baseURL override');
        }
        const compatible = createOpenAI({
          baseURL: overrides.baseURL,
          apiKey: overrides.apiKey ?? 'no-key',
        });
        return compatible(modelId);
      }

      default:
        throw new Error(
          `Unknown LLM provider: '${provider}'. ` +
            `Supported: anthropic, openai, ollama, openai-compatible`,
        );
    }
  }
}

// ── Default singleton ─────────────────────────────────────────

export const defaultModelFactory = new ModelFactory();
