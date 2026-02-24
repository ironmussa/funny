/**
 * Model Factory — resolves provider + model into connection details.
 *
 * Returns { baseURL, apiKey, modelId } for direct HTTP calls.
 * baseURL is the server root (e.g. http://localhost:4010) — callers
 * append the endpoint path (e.g. /v1/runs).
 */

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

// ── Resolved Model ───────────────────────────────────────────

export interface ResolvedModel {
  baseURL: string;
  apiKey?: string;
  modelId: string;
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
   * Resolve a provider + model ID into connection details.
   *
   * Returns { baseURL, apiKey, modelId } for direct HTTP calls.
   *
   * Examples:
   *   resolve('funny-api-acp', 'sonnet')
   *   resolve('ollama', 'llama3:70b')
   *   resolve('openai', 'gpt-4-turbo')
   */
  resolve(
    provider: string,
    modelId: string,
    overrides?: { apiKey?: string; baseURL?: string },
  ): ResolvedModel {
    const resolvedId = resolveModelId(provider, modelId);

    switch (provider) {
      case 'anthropic': {
        const baseURL = overrides?.baseURL ?? this.config.anthropic?.baseURL ?? 'https://api.anthropic.com';
        const apiKey = overrides?.apiKey ?? this.config.anthropic?.apiKey ?? process.env.ANTHROPIC_API_KEY;
        return { baseURL, apiKey, modelId: resolvedId };
      }

      case 'openai': {
        const baseURL = overrides?.baseURL ?? this.config.openai?.baseURL ?? 'https://api.openai.com/v1';
        const apiKey = overrides?.apiKey ?? this.config.openai?.apiKey ?? process.env.OPENAI_API_KEY;
        return { baseURL, apiKey, modelId: resolvedId };
      }

      case 'funny-api-acp': {
        const baseURL = overrides?.baseURL
          ?? this.config['funny-api-acp']?.baseURL
          ?? process.env.API_ACP_URL
          ?? 'http://localhost:4010';
        const apiKey = overrides?.apiKey ?? this.config['funny-api-acp']?.apiKey;
        return { baseURL, apiKey, modelId: resolvedId };
      }

      case 'ollama': {
        const baseURL = overrides?.baseURL
          ?? this.config.ollama?.baseURL
          ?? process.env.OLLAMA_BASE_URL
          ?? 'http://localhost:11434/v1';
        return { baseURL, apiKey: 'ollama', modelId: resolvedId };
      }

      case 'openai-compatible': {
        if (!overrides?.baseURL) {
          throw new Error('openai-compatible provider requires a baseURL override');
        }
        return {
          baseURL: overrides.baseURL,
          apiKey: overrides.apiKey ?? 'no-key',
          modelId: resolvedId,
        };
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
