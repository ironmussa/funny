/**
 * Client-facing provider and model configuration.
 *
 * Thin adapter over the shared MODEL_REGISTRY (see @funny/shared/models).
 * All provider/model lists, context windows, and i18n keys live in
 * @funny/shared — this file only adds client concerns (translation
 * function, unified `provider:model` keys, effort availability).
 */

import type { AgentProvider } from '@funny/shared';
import { MODEL_REGISTRY, PROVIDER_LABELS } from '@funny/shared/models';

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

const REGISTRY_PROVIDERS = Object.keys(MODEL_REGISTRY) as (keyof typeof MODEL_REGISTRY)[];

export const PROVIDERS: ProviderConfig[] = REGISTRY_PROVIDERS.map((value) => ({
  value: value as AgentProvider,
  label: PROVIDER_LABELS[value] ?? value,
}));

// ── Models per provider (derived from shared registry) ─────────

export const PROVIDER_MODELS: Record<string, ModelConfig[]> = Object.fromEntries(
  REGISTRY_PROVIDERS.map((provider) => [
    provider,
    Object.entries(MODEL_REGISTRY[provider]).map(([value, def]) => ({
      value,
      i18nKey: def.i18nKey,
      fallback: def.label,
      contextWindow: def.contextWindow,
    })),
  ]),
);

/** All models across all providers (flattened). */
export const ALL_MODELS: ModelConfig[] = Object.values(PROVIDER_MODELS).flat();

function translateOrFallback(t: (key: string) => string, m: ModelConfig): string {
  const translated = t(`thread.model.${m.i18nKey}`);
  return translated.startsWith('thread.model.') ? m.fallback : translated;
}

/**
 * Get models for a provider as `{ value, label }` pairs using a translation function.
 * Falls back to the hardcoded label if the i18n key is missing.
 */
export function getModelOptions(
  provider: string,
  t: (key: string) => string,
): { value: string; label: string }[] {
  const models = PROVIDER_MODELS[provider] ?? PROVIDER_MODELS.claude;
  return models.map((m) => ({ value: m.value, label: translateOrFallback(t, m) }));
}

/**
 * Get all models across all providers as `{ value, label }` pairs.
 */
export function getAllModelOptions(t: (key: string) => string): { value: string; label: string }[] {
  return ALL_MODELS.map((m) => ({ value: m.value, label: translateOrFallback(t, m) }));
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
      models: models.map((m) => ({
        value: `${p.value}:${m.value}`,
        label: translateOrFallback(t, m),
        provider: p.value,
        providerLabel: p.label,
        model: m.value,
      })),
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
  {
    value: 'xhigh',
    label: 'Extra High',
    description: 'Long-horizon agentic work — Opus 4.7 / 4.8',
  },
  { value: 'max', label: 'Max', description: 'Frontier reasoning — highest cost' },
];

/** Providers that support effort/reasoning level configuration. */
const PROVIDERS_WITH_EFFORT = new Set(['claude', 'codex']);

// Claude models that support effort beyond low/medium/high.
// Keys are the friendly model names from `@funny/shared` models registry.
const CLAUDE_MODELS_WITH_XHIGH = new Set(['opus-4.7', 'opus-4.8']);
const CLAUDE_MODELS_WITH_MAX = new Set(['opus-4.7', 'opus-4.8', 'opus', 'sonnet-4.6']);

/** Get available effort levels for a given provider + model. Returns empty array if not supported. */
export function getEffortLevels(model: string, provider?: string): EffortConfig[] {
  if (provider && !PROVIDERS_WITH_EFFORT.has(provider)) return [];
  if (provider !== 'claude') {
    // Codex exposes low/medium/high/xhigh. Keep max limited to Claude models
    // that advertise it below.
    return EFFORT_LEVELS.filter(
      (e) => e.value === 'low' || e.value === 'medium' || e.value === 'high' || e.value === 'xhigh',
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

/** Why a provider group is unavailable in the picker (model-picker-availability). */
export type ProviderUnavailableReason = 'not-installed' | 'no-runner';

export interface ModelSelectGroup {
  provider: string;
  providerLabel: string;
  models: { value: string; label: string; disabled?: boolean }[];
  /** Set when the provider is active but cannot run — its models render greyed. */
  disabled?: boolean;
  disabledReason?: ProviderUnavailableReason;
}

/** Status placeholders (loading, configure hints) are not user-toggleable. */
export function isPromptModelConfigurable(combinedKey: string): boolean {
  return !combinedKey.includes('__');
}

/**
 * Filter model groups for the prompt picker. Hidden models are omitted unless
 * they are the currently selected model (so the trigger still shows a label).
 */
export function filterVisibleModelGroups(
  groups: ModelSelectGroup[],
  hiddenModels: readonly string[],
  pinnedModel?: string,
): ModelSelectGroup[] {
  const hidden = new Set(hiddenModels);
  return groups
    .map((group) => ({
      ...group,
      models: group.models.filter((model) => {
        if (!isPromptModelConfigurable(model.value)) return true;
        if (model.value === pinnedModel) return true;
        return !hidden.has(model.value);
      }),
    }))
    .filter((group) => group.models.length > 0);
}
