import { describe, test, expect } from 'vitest';

import {
  PROVIDERS,
  PROVIDER_MODELS,
  ALL_MODELS,
  getModelOptions,
  getAllModelOptions,
  getUnifiedModelOptions,
  getContextWindow,
  parseUnifiedModel,
} from '@/lib/providers';

/** Mock translation function — returns the key itself (simulating missing i18n). */
const tPassthrough = (key: string) => key;

/** Mock translation function — returns a "translated" label. */
const tTranslated = (key: string) => {
  const map: Record<string, string> = {
    'thread.model.haiku': 'Haiku 4.5 (translated)',
    'thread.model.sonnet': 'Sonnet 4.5 (translated)',
    'thread.model.opus': 'Opus 4.6 (translated)',
  };
  return map[key] ?? key;
};

// ── Constants ────────────────────────────────────────────────────

describe('PROVIDERS', () => {
  test('contains claude, codex, and gemini', () => {
    const values = PROVIDERS.map((p) => p.value);
    expect(values).toContain('claude');
    expect(values).toContain('codex');
    expect(values).toContain('gemini');
  });
});

describe('PROVIDER_MODELS', () => {
  test('has models for each provider', () => {
    for (const p of PROVIDERS) {
      expect(PROVIDER_MODELS[p.value]).toBeDefined();
      expect(PROVIDER_MODELS[p.value].length).toBeGreaterThan(0);
    }
  });

  test('each model has required fields', () => {
    for (const models of Object.values(PROVIDER_MODELS)) {
      for (const m of models) {
        expect(m.value).toBeTruthy();
        expect(m.fallback).toBeTruthy();
        expect(m.contextWindow).toBeGreaterThan(0);
      }
    }
  });
});

describe('ALL_MODELS', () => {
  test('is a flattened array of all provider models', () => {
    const expected = Object.values(PROVIDER_MODELS).flat().length;
    expect(ALL_MODELS).toHaveLength(expected);
  });
});

// ── getModelOptions ──────────────────────────────────────────────

describe('getModelOptions', () => {
  test('returns models for claude provider', () => {
    const options = getModelOptions('claude', tPassthrough);
    expect(options.length).toBeGreaterThan(0);
    expect(options.some((o) => o.value === 'sonnet')).toBe(true);
  });

  test('falls back to fallback label when i18n key not translated', () => {
    const options = getModelOptions('claude', tPassthrough);
    // tPassthrough returns the key itself which starts with "thread.model."
    // So it should use the fallback
    for (const opt of options) {
      expect(opt.label).not.toContain('thread.model.');
    }
  });

  test('uses translated label when available', () => {
    const options = getModelOptions('claude', tTranslated);
    const haiku = options.find((o) => o.value === 'haiku');
    expect(haiku!.label).toBe('Haiku 4.5 (translated)');
  });

  test('falls back to claude models for unknown provider', () => {
    const options = getModelOptions('unknown', tPassthrough);
    const claudeOptions = getModelOptions('claude', tPassthrough);
    expect(options).toEqual(claudeOptions);
  });
});

// ── getAllModelOptions ────────────────────────────────────────────

describe('getAllModelOptions', () => {
  test('returns all models across all providers', () => {
    const options = getAllModelOptions(tPassthrough);
    expect(options.length).toBe(ALL_MODELS.length);
  });
});

// ── getUnifiedModelOptions ───────────────────────────────────────

describe('getUnifiedModelOptions', () => {
  test('returns groups for each provider', () => {
    const groups = getUnifiedModelOptions(tPassthrough);
    expect(groups).toHaveLength(PROVIDERS.length);
  });

  test('each model has provider:model combined value', () => {
    const groups = getUnifiedModelOptions(tPassthrough);
    for (const group of groups) {
      for (const model of group.models) {
        expect(model.value).toContain(':');
        expect(model.value.startsWith(group.provider + ':')).toBe(true);
      }
    }
  });

  test('model objects include provider metadata', () => {
    const groups = getUnifiedModelOptions(tPassthrough);
    const claudeGroup = groups.find((g) => g.provider === 'claude')!;
    const sonnet = claudeGroup.models.find((m) => m.model === 'sonnet')!;
    expect(sonnet.provider).toBe('claude');
    expect(sonnet.providerLabel).toBe('Claude');
    expect(sonnet.value).toBe('claude:sonnet');
  });
});

// ── getContextWindow ─────────────────────────────────────────────

describe('getContextWindow', () => {
  test('returns correct context window for claude haiku', () => {
    expect(getContextWindow('claude', 'haiku')).toBe(200_000);
  });

  test('returns correct context window for gemini 2.5 flash', () => {
    expect(getContextWindow('gemini', 'gemini-2.5-flash')).toBe(1_048_576);
  });

  test('returns default 200k for unknown provider', () => {
    expect(getContextWindow('unknown', 'whatever')).toBe(200_000);
  });

  test('returns default 200k for unknown model in known provider', () => {
    expect(getContextWindow('claude', 'unknown-model')).toBe(200_000);
  });
});

// ── parseUnifiedModel ────────────────────────────────────────────

describe('parseUnifiedModel', () => {
  test('parses provider:model format', () => {
    expect(parseUnifiedModel('claude:sonnet')).toEqual({ provider: 'claude', model: 'sonnet' });
  });

  test('handles gemini models with multiple colons in name', () => {
    // Only splits on first colon
    expect(parseUnifiedModel('gemini:gemini-2.5-flash')).toEqual({
      provider: 'gemini',
      model: 'gemini-2.5-flash',
    });
  });

  test('defaults to claude provider when no colon', () => {
    expect(parseUnifiedModel('sonnet')).toEqual({ provider: 'claude', model: 'sonnet' });
  });

  test('handles empty string', () => {
    expect(parseUnifiedModel('')).toEqual({ provider: 'claude', model: '' });
  });
});
