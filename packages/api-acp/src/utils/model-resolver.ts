/**
 * Model Resolver — maps OpenAI-style model IDs to provider + full model ID.
 *
 * Supports:
 *   - Full Claude model IDs: "claude-sonnet-4-5-20250929" → anthropic
 *   - Short aliases: "claude-sonnet", "claude-opus", "claude-haiku"
 *   - OpenAI models: "gpt-4-turbo", "gpt-4o", "o3", etc.
 *   - Gemini models: "gemini-2.5-pro", etc.
 *   - Ollama models via "ollama/" prefix: "ollama/llama3:70b"
 */

const CLAUDE_ALIASES: Record<string, string> = {
  'claude-sonnet': 'claude-sonnet-4-5-20250929',
  'claude-sonnet-4.5': 'claude-sonnet-4-5-20250929',
  'claude-sonnet-4.6': 'claude-sonnet-4-6',
  'claude-opus': 'claude-opus-4-6',
  'claude-opus-4.6': 'claude-opus-4-6',
  'claude-haiku': 'claude-haiku-4-5-20251001',
  'claude-haiku-4.5': 'claude-haiku-4-5-20251001',
};

export interface ResolvedModel {
  provider: string;
  modelId: string;
}

export function resolveModel(model: string): ResolvedModel {
  // Check Claude aliases first
  const aliased = CLAUDE_ALIASES[model];
  if (aliased) {
    return { provider: 'anthropic', modelId: aliased };
  }

  // Ollama prefix
  if (model.startsWith('ollama/')) {
    return { provider: 'ollama', modelId: model.slice('ollama/'.length) };
  }

  // Detect provider from model ID prefix
  if (model.startsWith('claude-')) {
    return { provider: 'anthropic', modelId: model };
  }

  if (
    model.startsWith('gpt-') ||
    model.startsWith('o1') ||
    model.startsWith('o3') ||
    model.startsWith('o4')
  ) {
    return { provider: 'openai', modelId: model };
  }

  if (model.startsWith('gemini-')) {
    // Gemini models go through OpenAI-compatible interface via google's API
    // but ModelFactory doesn't have a 'gemini' provider — use openai-compatible
    // or the user can configure a custom base URL
    return { provider: 'openai', modelId: model };
  }

  // Default: assume anthropic for unknown models
  return { provider: 'anthropic', modelId: model };
}

/** Get all models that this proxy can advertise. */
export function getAdvertisedModels(): Array<{ id: string; owned_by: string }> {
  return [
    // Claude
    { id: 'claude-sonnet-4-5-20250929', owned_by: 'anthropic' },
    { id: 'claude-sonnet-4-6', owned_by: 'anthropic' },
    { id: 'claude-opus-4-6', owned_by: 'anthropic' },
    { id: 'claude-haiku-4-5-20251001', owned_by: 'anthropic' },
    // Aliases
    { id: 'claude-sonnet', owned_by: 'anthropic' },
    { id: 'claude-opus', owned_by: 'anthropic' },
    { id: 'claude-haiku', owned_by: 'anthropic' },
  ];
}
