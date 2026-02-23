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
  'funny-api-acp'?: {
    apiKey?: string;
    baseURL?: string;
  };
  ollama?: {
    baseURL?: string;
  };
}

// ── Short name → full model ID maps ──────────────────────────

const ANTHROPIC_MODEL_ALIASES: Record<string, string> = {
  opus: 'claude-opus-4-6',
  sonnet: 'claude-sonnet-4-5-20250929',
  haiku: 'claude-haiku-4-5-20251001',
};

const OPENAI_MODEL_ALIASES: Record<string, string> = {
  'gpt-4': 'gpt-4-turbo',
  'gpt-4o': 'gpt-4o',
  'o1': 'o1',
  // Claude short names — for OpenAI-compatible servers backed by Claude
  opus: 'claude-opus-4-6',
  sonnet: 'claude-sonnet-4-5-20250929',
  haiku: 'claude-haiku-4-5-20251001',
};

const FUNNY_API_ACP_ALIASES: Record<string, string> = {
  opus: 'claude-opus-4-6',
  sonnet: 'claude-sonnet-4-5-20250929',
  haiku: 'claude-haiku-4-5-20251001',
};

function resolveModelId(provider: string, modelId: string): string {
  if (provider === 'anthropic' && ANTHROPIC_MODEL_ALIASES[modelId]) {
    return ANTHROPIC_MODEL_ALIASES[modelId];
  }
  if (provider === 'openai' && OPENAI_MODEL_ALIASES[modelId]) {
    return OPENAI_MODEL_ALIASES[modelId];
  }
  if (provider === 'funny-api-acp' && FUNNY_API_ACP_ALIASES[modelId]) {
    return FUNNY_API_ACP_ALIASES[modelId];
  }
  return modelId;
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
   * Supports short aliases (e.g. 'opus', 'sonnet', 'haiku') which are
   * automatically resolved to full model IDs.
   *
   * Examples:
   *   create('anthropic', 'claude-sonnet-4-5-20250929')
   *   create('anthropic', 'opus')  // resolved to 'claude-opus-4-6'
   *   create('openai', 'gpt-4-turbo')
   *   create('ollama', 'llama3:70b')
   *   create('openai-compatible', 'my-model', { baseURL: 'http://localhost:8000/v1' })
   */
  create(
    provider: string,
    modelId: string,
    overrides?: { apiKey?: string; baseURL?: string },
  ): LanguageModel {
    const resolvedId = resolveModelId(provider, modelId);

    switch (provider) {
      case 'anthropic': {
        const anthropic = createAnthropic({
          apiKey: overrides?.apiKey ?? this.config.anthropic?.apiKey ?? process.env.ANTHROPIC_API_KEY,
          baseURL: overrides?.baseURL ?? this.config.anthropic?.baseURL,
        });
        return anthropic(resolvedId);
      }

      case 'openai': {
        const baseURL = overrides?.baseURL ?? this.config.openai?.baseURL;
        const apiKey = overrides?.apiKey ?? this.config.openai?.apiKey ?? process.env.OPENAI_API_KEY;
        const openai = createOpenAI({
          apiKey: apiKey || (baseURL ? 'no-key' : undefined),
          baseURL,
        });
        return openai(resolvedId);
      }

      case 'funny-api-acp': {
        const acpBaseURL = overrides?.baseURL ?? this.config['funny-api-acp']?.baseURL;
        const acpApiKey = overrides?.apiKey ?? this.config['funny-api-acp']?.apiKey;
        const acp = createOpenAI({
          apiKey: acpApiKey || (acpBaseURL ? 'no-key' : undefined),
          baseURL: acpBaseURL,
        });
        // Force /v1/chat/completions instead of /v1/responses
        return acp.chat(resolvedId);
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
        return ollama(resolvedId);
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
        return compatible(resolvedId);
      }

      default:
        throw new Error(
          `Unknown LLM provider: '${provider}'. ` +
            `Supported: anthropic, funny-api-acp, openai, ollama, openai-compatible`,
        );
    }
  }
}

// ── Default singleton ─────────────────────────────────────────

export const defaultModelFactory = new ModelFactory();
