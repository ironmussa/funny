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
];

// ── Models per provider ────────────────────────────────────────

export const PROVIDER_MODELS: Record<string, ModelConfig[]> = {
  claude: [
    { value: 'haiku', i18nKey: 'haiku', fallback: 'Haiku 4.5', contextWindow: 200_000 },
    { value: 'sonnet', i18nKey: 'sonnet', fallback: 'Sonnet 4.5', contextWindow: 200_000 },
    { value: 'sonnet-4.6', i18nKey: 'sonnet46', fallback: 'Sonnet 4.6', contextWindow: 200_000 },
    { value: 'opus', i18nKey: 'opus', fallback: 'Opus 4.6', contextWindow: 200_000 },
  ],
  codex: [
    { value: 'o3', i18nKey: 'o3', fallback: 'o3', contextWindow: 200_000 },
    { value: 'o4-mini', i18nKey: 'o4mini', fallback: 'o4-mini', contextWindow: 200_000 },
    { value: 'codex-mini', i18nKey: 'codexMini', fallback: 'Codex Mini', contextWindow: 200_000 },
  ],
  gemini: [
    { value: 'gemini-3-flash-preview', i18nKey: 'gemini3flash', fallback: 'Gemini 3 Flash', contextWindow: 1_000_000 },
    { value: 'gemini-3-pro-preview', i18nKey: 'gemini3pro', fallback: 'Gemini 3 Pro', contextWindow: 1_000_000 },
    { value: 'gemini-2.5-flash', i18nKey: 'gemini25flash', fallback: 'Gemini 2.5 Flash', contextWindow: 1_048_576 },
    { value: 'gemini-2.5-pro', i18nKey: 'gemini25pro', fallback: 'Gemini 2.5 Pro', contextWindow: 1_048_576 },
    { value: 'gemini-2.0-flash', i18nKey: 'gemini20flash', fallback: 'Gemini 2.0 Flash', contextWindow: 1_048_576 },
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
