/**
 * Centralized provider and model configuration for the client UI.
 *
 * Single source of truth — used by PromptInput, SettingsDetailView,
 * NewThreadDialog, and any other component that needs provider/model lists.
 */

import type { AgentProvider } from '@funny/shared';

export interface ProviderConfig {
  value: AgentProvider;
  label: string;
}

export interface ModelConfig {
  value: string;
  /** i18n key under `thread.model.*` */
  i18nKey: string;
  /** Fallback label if i18n is not available */
  fallback: string;
  /** Context window size in tokens */
  contextWindow: number;
}

// ── Providers ──────────────────────────────────────────────────

export const PROVIDERS: ProviderConfig[] = [
  { value: 'claude', label: 'Claude' },
  { value: 'codex', label: 'Codex' },
  { value: 'gemini', label: 'Gemini' },
  { value: 'deepagent', label: 'Deep Agent' },
  { value: 'openswe', label: 'OpenSWE' },
];

// ── Models per provider ────────────────────────────────────────

export const PROVIDER_MODELS: Record<string, ModelConfig[]> = {
  claude: [
    { value: 'haiku', i18nKey: 'haiku', fallback: 'Haiku 4.5', contextWindow: 200_000 },
    { value: 'sonnet', i18nKey: 'sonnet', fallback: 'Sonnet 4.5', contextWindow: 200_000 },
    { value: 'sonnet-4.6', i18nKey: 'sonnet46', fallback: 'Sonnet 4.6', contextWindow: 200_000 },
    { value: 'opus', i18nKey: 'opus', fallback: 'Opus 4.6', contextWindow: 200_000 },
    { value: 'opus-4.7', i18nKey: 'opus47', fallback: 'Opus 4.7', contextWindow: 200_000 },
  ],
  codex: [
    { value: 'o3', i18nKey: 'o3', fallback: 'o3', contextWindow: 200_000 },
    { value: 'o4-mini', i18nKey: 'o4mini', fallback: 'o4-mini', contextWindow: 200_000 },
    { value: 'codex-mini', i18nKey: 'codexMini', fallback: 'Codex Mini', contextWindow: 200_000 },
  ],
  gemini: [
    {
      value: 'gemini-3-flash-preview',
      i18nKey: 'gemini3flash',
      fallback: 'Gemini 3 Flash',
      contextWindow: 1_000_000,
    },
    {
      value: 'gemini-3-pro-preview',
      i18nKey: 'gemini3pro',
      fallback: 'Gemini 3 Pro',
      contextWindow: 1_000_000,
    },
    {
      value: 'gemini-2.5-flash',
      i18nKey: 'gemini25flash',
      fallback: 'Gemini 2.5 Flash',
      contextWindow: 1_048_576,
    },
    {
      value: 'gemini-2.5-pro',
      i18nKey: 'gemini25pro',
      fallback: 'Gemini 2.5 Pro',
      contextWindow: 1_048_576,
    },
    {
      value: 'gemini-2.0-flash',
      i18nKey: 'gemini20flash',
      fallback: 'Gemini 2.0 Flash',
      contextWindow: 1_048_576,
    },
  ],
  deepagent: [
    {
      value: 'minimax-m2.7',
      i18nKey: 'minimaxM27',
      fallback: 'MiniMax M2.7',
      contextWindow: 204_800,
    },
    {
      value: 'minimax-m2.7-highspeed',
      i18nKey: 'minimaxM27Highspeed',
      fallback: 'MiniMax M2.7 Highspeed',
      contextWindow: 204_800,
    },
    {
      value: 'deepagent-gpt-4o',
      i18nKey: 'deepagentGpt4o',
      fallback: 'GPT-4o',
      contextWindow: 128_000,
    },
    {
      value: 'deepagent-sonnet',
      i18nKey: 'deepagentSonnet',
      fallback: 'Sonnet 4.5',
      contextWindow: 200_000,
    },
    {
      value: 'deepagent-gemini-2.5-flash',
      i18nKey: 'deepagentGemini25flash',
      fallback: 'Gemini 2.5 Flash',
      contextWindow: 1_048_576,
    },
    {
      value: 'deepagent-gemini-2.5-pro',
      i18nKey: 'deepagentGemini25pro',
      fallback: 'Gemini 2.5 Pro',
      contextWindow: 1_048_576,
    },
    {
      value: 'deepagent-gemini-3-flash',
      i18nKey: 'deepagentGemini3flash',
      fallback: 'Gemini 3 Flash',
      contextWindow: 1_000_000,
    },
    {
      value: 'deepagent-gemini-3-pro',
      i18nKey: 'deepagentGemini3pro',
      fallback: 'Gemini 3 Pro',
      contextWindow: 1_000_000,
    },
    {
      value: 'deepagent-grok-3',
      i18nKey: 'deepagentGrok3',
      fallback: 'Grok 3',
      contextWindow: 131_072,
    },
    {
      value: 'deepagent-grok-3-mini',
      i18nKey: 'deepagentGrok3mini',
      fallback: 'Grok 3 Mini',
      contextWindow: 131_072,
    },
    {
      value: 'deepagent-glm-5.1',
      i18nKey: 'deepagentGlm51',
      fallback: 'GLM-5.1',
      contextWindow: 128_000,
    },
    {
      value: 'deepagent-glm-5-turbo',
      i18nKey: 'deepagentGlm5turbo',
      fallback: 'GLM-5 Turbo',
      contextWindow: 128_000,
    },
    {
      value: 'deepagent-glm-5v-turbo',
      i18nKey: 'deepagentGlm5vturbo',
      fallback: 'GLM-5V Turbo',
      contextWindow: 128_000,
    },
  ],
  openswe: [
    {
      value: 'openswe-default',
      i18nKey: 'opensweDefault',
      fallback: 'OpenSWE Default',
      contextWindow: 200_000,
    },
  ],
};

/** All models across all providers (flattened). */
export const ALL_MODELS: ModelConfig[] = Object.values(PROVIDER_MODELS).flat();

/**
 * Get models for a provider as `{ value, label }` pairs using a translation function.
 * Falls back to the hardcoded label if the i18n key is missing.
 */
export function getModelOptions(
  provider: string,
  t: (key: string) => string,
): { value: string; label: string }[] {
  const models = PROVIDER_MODELS[provider] ?? PROVIDER_MODELS.claude;
  return models.map((m) => {
    const translated = t(`thread.model.${m.i18nKey}`);
    // If i18next returns the key itself, use fallback
    const label = translated.startsWith('thread.model.') ? m.fallback : translated;
    return { value: m.value, label };
  });
}

/**
 * Get all models across all providers as `{ value, label }` pairs.
 */
export function getAllModelOptions(t: (key: string) => string): { value: string; label: string }[] {
  return ALL_MODELS.map((m) => {
    const translated = t(`thread.model.${m.i18nKey}`);
    const label = translated.startsWith('thread.model.') ? m.fallback : translated;
    return { value: m.value, label };
  });
}

export interface UnifiedModelOption {
  /** Combined key: `provider:model` */
  value: string;
  label: string;
  provider: string;
  providerLabel: string;
  model: string;
}

/**
 * Get all models from all providers as a flat list with `provider:model` combined keys,
 * grouped by provider for display.
 */
export function getUnifiedModelOptions(
  t: (key: string) => string,
): { provider: string; providerLabel: string; models: UnifiedModelOption[] }[] {
  return PROVIDERS.map((p) => {
    const models = PROVIDER_MODELS[p.value] ?? [];
    return {
      provider: p.value,
      providerLabel: p.label,
      models: models.map((m) => {
        const translated = t(`thread.model.${m.i18nKey}`);
        const label = translated.startsWith('thread.model.') ? m.fallback : translated;
        return {
          value: `${p.value}:${m.value}`,
          label,
          provider: p.value,
          providerLabel: p.label,
          model: m.value,
        };
      }),
    };
  });
}

// ── Effort levels ───────────────────────────────────────────────

export interface EffortConfig {
  value: string;
  label: string;
  description: string;
}

export const EFFORT_LEVELS: EffortConfig[] = [
  { value: 'low', label: 'Low', description: 'Minimal thinking — fastest' },
  { value: 'medium', label: 'Medium', description: 'Balanced speed and quality' },
  { value: 'high', label: 'High', description: 'Deep reasoning (default)' },
  { value: 'xhigh', label: 'Extra High', description: 'Long-horizon agentic work — Opus 4.7 only' },
  { value: 'max', label: 'Max', description: 'Frontier reasoning — highest cost' },
];

/** Providers that support effort/reasoning level configuration. */
const PROVIDERS_WITH_EFFORT = new Set(['claude', 'codex']);

// Claude models that support effort beyond low/medium/high.
// Keys are the friendly model names from `@funny/shared` models registry.
const CLAUDE_MODELS_WITH_XHIGH = new Set(['opus-4.7']);
const CLAUDE_MODELS_WITH_MAX = new Set(['opus-4.7', 'opus', 'sonnet-4.6']);

/** Get available effort levels for a given provider + model. Returns empty array if not supported. */
export function getEffortLevels(model: string, provider?: string): EffortConfig[] {
  if (provider && !PROVIDERS_WITH_EFFORT.has(provider)) return [];
  if (provider !== 'claude') {
    // Codex and other effort-capable providers only expose low/medium/high.
    return EFFORT_LEVELS.filter(
      (e) => e.value === 'low' || e.value === 'medium' || e.value === 'high',
    );
  }
  return EFFORT_LEVELS.filter((e) => {
    if (e.value === 'xhigh') return CLAUDE_MODELS_WITH_XHIGH.has(model);
    if (e.value === 'max') return CLAUDE_MODELS_WITH_MAX.has(model);
    return true;
  });
}

const DEFAULT_CONTEXT_WINDOW = 200_000;

/** Get the context window size (in tokens) for a given provider + model. */
export function getContextWindow(provider: string, model: string): number {
  const models = PROVIDER_MODELS[provider];
  const found = models?.find((m) => m.value === model);
  return found?.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
}

/** Parse a `provider:model` combined key back into its parts. */
export function parseUnifiedModel(combined: string): { provider: string; model: string } {
  const idx = combined.indexOf(':');
  if (idx === -1) return { provider: 'claude', model: combined };
  return { provider: combined.slice(0, idx), model: combined.slice(idx + 1) };
}
