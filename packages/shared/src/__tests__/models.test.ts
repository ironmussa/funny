import { describe, test, expect } from 'bun:test';

import {
  resolveModelId,
  getDefaultModel,
  getProviderModels,
  getProviderModelsWithLabels,
  resolvePermissionMode,
  resolveResumePermissionMode,
  getDefaultAllowedTools,
  getAskModeTools,
  isModelForProvider,
} from '../models.js';

// ── resolveModelId ──────────────────────────────────────────────

describe('resolveModelId', () => {
  describe('claude provider', () => {
    test('resolves sonnet to its full model ID', () => {
      expect(resolveModelId('claude', 'sonnet')).toBe('claude-sonnet-4-5-20250929');
    });

    test('resolves opus to its full model ID (with 1M context alias)', () => {
      expect(resolveModelId('claude', 'opus')).toBe('claude-opus-4-6[1m]');
    });

    test('resolves haiku to its full model ID', () => {
      expect(resolveModelId('claude', 'haiku')).toBe('claude-haiku-4-5-20251001');
    });

    test('throws on unknown claude model', () => {
      expect(() => resolveModelId('claude', 'o3' as any)).toThrow('Unknown Claude model: o3');
    });

    test('throws on codex model passed to claude', () => {
      expect(() => resolveModelId('claude', 'gpt-5.4' as any)).toThrow('Unknown Claude model');
    });
  });

  describe('codex provider', () => {
    test('resolves gpt-5.4 to gpt-5.4', () => {
      expect(resolveModelId('codex', 'gpt-5.4')).toBe('gpt-5.4');
    });

    test('resolves gpt-5.4-mini to gpt-5.4-mini', () => {
      expect(resolveModelId('codex', 'gpt-5.4-mini')).toBe('gpt-5.4-mini');
    });

    test('resolves gpt-5.3-codex to gpt-5.3-codex', () => {
      expect(resolveModelId('codex', 'gpt-5.3-codex')).toBe('gpt-5.3-codex');
    });

    test('resolves gpt-5.2 to gpt-5.2', () => {
      expect(resolveModelId('codex', 'gpt-5.2')).toBe('gpt-5.2');
    });

    test('throws on unknown codex model', () => {
      expect(() => resolveModelId('codex', 'sonnet' as any)).toThrow('Unknown Codex model: sonnet');
    });

    test('throws on claude model passed to codex', () => {
      expect(() => resolveModelId('codex', 'haiku' as any)).toThrow('Unknown Codex model');
    });
  });

  describe('gemini provider', () => {
    test('resolves gemini-2.5-flash', () => {
      expect(resolveModelId('gemini', 'gemini-2.5-flash')).toBe('gemini-2.5-flash');
    });

    test('resolves gemini-3.1-pro-preview', () => {
      expect(resolveModelId('gemini', 'gemini-3.1-pro-preview')).toBe('gemini-3.1-pro-preview');
    });

    test('resolves gemini-3-flash-preview', () => {
      expect(resolveModelId('gemini', 'gemini-3-flash-preview')).toBe('gemini-3-flash-preview');
    });

    test('throws on unknown gemini model', () => {
      expect(() => resolveModelId('gemini', 'sonnet' as any)).toThrow('Unknown Gemini model');
    });
  });

  describe('deepagent provider', () => {
    test('resolves deepagent-gemini-3-flash with google-genai provider prefix', () => {
      expect(resolveModelId('deepagent', 'deepagent-gemini-3-flash')).toBe(
        'google-genai:gemini-3-flash-preview',
      );
    });

    test('resolves deepagent-gemini-2.5-flash with google-genai provider prefix', () => {
      expect(resolveModelId('deepagent', 'deepagent-gemini-2.5-flash')).toBe(
        'google-genai:gemini-2.5-flash',
      );
    });

    test('resolves deepagent-sonnet to bare model name', () => {
      expect(resolveModelId('deepagent', 'deepagent-sonnet')).toBe('claude-sonnet-4-5-20250929');
    });

    test('resolves deepagent-gpt-4o to bare model name', () => {
      expect(resolveModelId('deepagent', 'deepagent-gpt-4o')).toBe('gpt-4o');
    });

    test('resolves minimax models with openai provider prefix', () => {
      expect(resolveModelId('deepagent', 'minimax-m2.7')).toBe('openai:MiniMax-M2.7');
    });

    test('throws on unknown deepagent model', () => {
      expect(() => resolveModelId('deepagent', 'sonnet' as any)).toThrow(
        'Unknown Deep Agent model',
      );
    });

    // Regression test: LangChain's initChatModel cannot infer providers from
    // prefixes like "google:" or "anthropic:" — only bare model names
    // (gemini-*, claude-*, gpt-*) or LangChain-specific prefixes like
    // "google-genai:" and "openai:" are supported. Model IDs for standard
    // providers must NOT include an unsupported provider prefix.
    test('non-minimax model IDs do not contain unsupported provider prefixes', () => {
      const unsupportedPrefixes = ['google:', 'anthropic:'];
      const models = getProviderModels('deepagent');
      for (const model of models) {
        if (model.startsWith('minimax')) continue; // minimax routes via openai: prefix
        const resolvedId = resolveModelId('deepagent', model);
        for (const prefix of unsupportedPrefixes) {
          expect(resolvedId.startsWith(prefix)).toBe(false);
        }
      }
    });

    // google-genai: is a supported LangChain prefix — Gemini models must use it
    // to avoid LangChain inferring google-vertexai (which requires GCP credentials)
    test('gemini model IDs use google-genai: prefix for AI Studio API key support', () => {
      const geminiModels = getProviderModels('deepagent').filter((m) => m.includes('gemini'));
      expect(geminiModels.length).toBeGreaterThan(0);
      for (const model of geminiModels) {
        const resolvedId = resolveModelId('deepagent', model);
        expect(resolvedId.startsWith('google-genai:')).toBe(true);
      }
    });
  });

  describe('llm-api provider', () => {
    test('passes model ID through directly', () => {
      expect(resolveModelId('llm-api', 'any-model-id' as any)).toBe('any-model-id');
    });
  });

  describe('unknown provider', () => {
    test('throws on completely unknown provider', () => {
      expect(() => resolveModelId('fake' as any, 'sonnet' as any)).toThrow(
        'Unknown provider: fake',
      );
    });

    test('throws on external provider', () => {
      expect(() => resolveModelId('external' as any, 'sonnet' as any)).toThrow(
        'Unknown provider: external',
      );
    });
  });
});

// ── getDefaultModel ─────────────────────────────────────────────

describe('getDefaultModel', () => {
  test('returns opus for claude', () => {
    expect(getDefaultModel('claude')).toBe('opus');
  });

  test('returns gpt-5.4 for codex', () => {
    expect(getDefaultModel('codex')).toBe('gpt-5.4');
  });

  test('returns gemini-3.1-pro-preview for gemini', () => {
    expect(getDefaultModel('gemini')).toBe('gemini-3.1-pro-preview');
  });

  test('returns opus for llm-api', () => {
    expect(getDefaultModel('llm-api')).toBe('opus');
  });

  test('throws on unknown provider', () => {
    expect(() => getDefaultModel('fake' as any)).toThrow('Unknown provider: fake');
  });
});

// ── getProviderModels ───────────────────────────────────────────

describe('getProviderModels', () => {
  test('returns all claude models', () => {
    const models = getProviderModels('claude');
    expect(models).toContain('sonnet');
    expect(models).toContain('sonnet-4.6');
    expect(models).toContain('opus');
    expect(models).toContain('opus-4.7');
    expect(models).toContain('haiku');
    expect(models).toHaveLength(5);
  });

  test('returns all codex models', () => {
    const models = getProviderModels('codex');
    expect(models).toContain('gpt-5.4');
    expect(models).toContain('gpt-5.4-mini');
    expect(models).toContain('gpt-5.3-codex');
    expect(models).toContain('gpt-5.2');
    expect(models).toHaveLength(4);
  });

  test('returns all gemini models', () => {
    const models = getProviderModels('gemini');
    expect(models).toContain('gemini-2.0-flash');
    expect(models).toContain('gemini-2.5-flash');
    expect(models).toContain('gemini-2.5-pro');
    expect(models).toContain('gemini-3.1-flash-lite-preview');
    expect(models).toContain('gemini-3.1-pro-preview');
    expect(models).toContain('gemini-3-flash-preview');
    expect(models).toHaveLength(6);
  });

  test('returns empty array for llm-api', () => {
    expect(getProviderModels('llm-api')).toEqual([]);
  });

  test('claude and codex models do not overlap', () => {
    const claudeModels = new Set(getProviderModels('claude'));
    const codexModels = new Set(getProviderModels('codex'));
    for (const m of codexModels) {
      expect(claudeModels.has(m)).toBe(false);
    }
  });

  test('throws on unknown provider', () => {
    expect(() => getProviderModels('unknown' as any)).toThrow('Unknown provider');
  });
});

// ── resolvePermissionMode ───────────────────────────────────────

describe('resolvePermissionMode', () => {
  describe('claude provider', () => {
    test('maps plan to plan', () => {
      expect(resolvePermissionMode('claude', 'plan')).toBe('plan');
    });

    test('maps auto to auto', () => {
      expect(resolvePermissionMode('claude', 'auto')).toBe('auto');
    });

    test('maps autoEdit to bypassPermissions', () => {
      expect(resolvePermissionMode('claude', 'autoEdit')).toBe('bypassPermissions');
    });

    test('maps confirmEdit to default', () => {
      expect(resolvePermissionMode('claude', 'confirmEdit')).toBe('default');
    });

    test('maps ask to default', () => {
      expect(resolvePermissionMode('claude', 'ask')).toBe('default');
    });
  });

  describe('codex provider', () => {
    test('returns undefined for plan mode', () => {
      expect(resolvePermissionMode('codex', 'plan')).toBeUndefined();
    });

    test('returns undefined for autoEdit mode', () => {
      expect(resolvePermissionMode('codex', 'autoEdit')).toBeUndefined();
    });

    test('returns undefined for confirmEdit mode', () => {
      expect(resolvePermissionMode('codex', 'confirmEdit')).toBeUndefined();
    });
  });

  describe('unknown provider', () => {
    test('returns undefined for unknown provider', () => {
      expect(resolvePermissionMode('external' as any, 'plan')).toBeUndefined();
    });
  });
});

// ── getDefaultAllowedTools ──────────────────────────────────────

describe('getDefaultAllowedTools', () => {
  test('claude returns a non-empty array of tool names', () => {
    const tools = getDefaultAllowedTools('claude');
    expect(tools.length).toBeGreaterThan(0);
  });

  test('claude tools include known tools', () => {
    const tools = getDefaultAllowedTools('claude');
    expect(tools).toContain('Read');
    expect(tools).toContain('Edit');
    expect(tools).toContain('Write');
    expect(tools).toContain('Bash');
    expect(tools).toContain('Glob');
    expect(tools).toContain('Grep');
    expect(tools).toContain('WebSearch');
    expect(tools).toContain('WebFetch');
    expect(tools).toContain('Task');
    expect(tools).toContain('TodoWrite');
    expect(tools).toContain('NotebookEdit');
  });

  test('codex returns an empty array', () => {
    expect(getDefaultAllowedTools('codex')).toEqual([]);
  });

  test('gemini returns an empty array', () => {
    expect(getDefaultAllowedTools('gemini')).toEqual([]);
  });

  test('llm-api returns lowercase tool names', () => {
    const tools = getDefaultAllowedTools('llm-api');
    expect(tools).toContain('bash');
    expect(tools).toContain('read');
    expect(tools).toContain('edit');
    expect(tools).toContain('glob');
    expect(tools).toContain('grep');
    expect(tools.length).toBeGreaterThan(0);
  });

  test('unknown provider returns an empty array', () => {
    expect(getDefaultAllowedTools('anything' as any)).toEqual([]);
  });

  test('returned array is a copy (not a reference to the internal array)', () => {
    const tools1 = getDefaultAllowedTools('claude');
    const tools2 = getDefaultAllowedTools('claude');
    expect(tools1).toEqual(tools2);
    expect(tools1).not.toBe(tools2);
  });
});

// ── isModelForProvider ──────────────────────────────────────────

describe('isModelForProvider', () => {
  describe('claude provider', () => {
    test('returns true for sonnet', () => {
      expect(isModelForProvider('claude', 'sonnet')).toBe(true);
    });

    test('returns true for opus', () => {
      expect(isModelForProvider('claude', 'opus')).toBe(true);
    });

    test('returns true for haiku', () => {
      expect(isModelForProvider('claude', 'haiku')).toBe(true);
    });

    test('returns false for codex models', () => {
      expect(isModelForProvider('claude', 'gpt-5.4')).toBe(false);
      expect(isModelForProvider('claude', 'gpt-5.2')).toBe(false);
      expect(isModelForProvider('claude', 'gpt-5.3-codex')).toBe(false);
    });
  });

  describe('codex provider', () => {
    test('returns true for gpt-5.4', () => {
      expect(isModelForProvider('codex', 'gpt-5.4')).toBe(true);
    });

    test('returns true for gpt-5.4-mini', () => {
      expect(isModelForProvider('codex', 'gpt-5.4-mini')).toBe(true);
    });

    test('returns true for gpt-5.3-codex', () => {
      expect(isModelForProvider('codex', 'gpt-5.3-codex')).toBe(true);
    });

    test('returns false for claude models', () => {
      expect(isModelForProvider('codex', 'sonnet')).toBe(false);
      expect(isModelForProvider('codex', 'opus')).toBe(false);
      expect(isModelForProvider('codex', 'haiku')).toBe(false);
    });
  });

  describe('gemini provider', () => {
    test('returns true for gemini models', () => {
      expect(isModelForProvider('gemini', 'gemini-2.5-flash')).toBe(true);
      expect(isModelForProvider('gemini', 'gemini-3.1-pro-preview')).toBe(true);
    });

    test('returns false for non-gemini models', () => {
      expect(isModelForProvider('gemini', 'sonnet')).toBe(false);
      expect(isModelForProvider('gemini', 'gpt-5.4')).toBe(false);
    });
  });

  describe('unknown provider', () => {
    test('returns false for any model', () => {
      expect(isModelForProvider('external' as any, 'sonnet')).toBe(false);
      expect(isModelForProvider('unknown' as any, 'gpt-5.4')).toBe(false);
    });
  });
});

// ── getProviderModelsWithLabels ──────────────────────────────────

describe('getProviderModelsWithLabels', () => {
  test('returns labeled models for claude', () => {
    const models = getProviderModelsWithLabels('claude');
    expect(models.length).toBeGreaterThan(0);
    for (const m of models) {
      expect(m).toHaveProperty('value');
      expect(m).toHaveProperty('label');
      expect(typeof m.label).toBe('string');
    }
  });

  test('returns labeled models for codex', () => {
    const models = getProviderModelsWithLabels('codex');
    expect(models.length).toBeGreaterThan(0);
    expect(models.some((m) => m.value === 'gpt-5.4')).toBe(true);
  });

  test('returns labeled models for gemini', () => {
    const models = getProviderModelsWithLabels('gemini');
    expect(models.length).toBeGreaterThan(0);
    expect(models.some((m) => m.value === 'gemini-2.5-flash')).toBe(true);
  });

  test('returns empty array for unknown provider', () => {
    expect(getProviderModelsWithLabels('fake' as any)).toEqual([]);
  });
});

// ── resolveResumePermissionMode ─────────────────────────────────

describe('resolveResumePermissionMode', () => {
  test('downgrades plan to acceptEdits for claude', () => {
    expect(resolveResumePermissionMode('claude', 'plan')).toBe('acceptEdits');
  });

  test('passes through non-plan modes for claude', () => {
    expect(resolveResumePermissionMode('claude', 'bypassPermissions')).toBe('bypassPermissions');
    expect(resolveResumePermissionMode('claude', 'default')).toBe('default');
    expect(resolveResumePermissionMode('claude', 'auto')).toBe('auto');
  });

  test('passes through undefined for non-claude providers', () => {
    expect(resolveResumePermissionMode('codex', undefined)).toBeUndefined();
    expect(resolveResumePermissionMode('gemini', undefined)).toBeUndefined();
  });
});

// ── getAskModeTools ─────────────────────────────────────────────

describe('getAskModeTools', () => {
  test('returns read-only tools', () => {
    const tools = getAskModeTools();
    expect(tools).toContain('Read');
    expect(tools).toContain('Glob');
    expect(tools).toContain('Grep');
    expect(tools).toContain('WebSearch');
    expect(tools).toContain('WebFetch');
    expect(tools).not.toContain('Task');
  });

  test('does not include write tools', () => {
    const tools = getAskModeTools();
    expect(tools).not.toContain('Edit');
    expect(tools).not.toContain('Write');
    expect(tools).not.toContain('Bash');
  });

  test('returns a copy each time', () => {
    const t1 = getAskModeTools();
    const t2 = getAskModeTools();
    expect(t1).toEqual(t2);
    expect(t1).not.toBe(t2);
  });
});

// ── Cross-cutting consistency checks ────────────────────────────

describe('cross-cutting consistency', () => {
  test('default model for each provider is in its model list', () => {
    for (const provider of ['claude', 'codex', 'gemini', 'deepagent'] as const) {
      const defaultModel = getDefaultModel(provider);
      const models = getProviderModels(provider);
      expect(models).toContain(defaultModel);
    }
  });

  test('every model in provider list can be resolved to an ID', () => {
    for (const provider of ['claude', 'codex', 'gemini', 'deepagent'] as const) {
      const models = getProviderModels(provider);
      for (const model of models) {
        expect(() => resolveModelId(provider, model)).not.toThrow();
        expect(typeof resolveModelId(provider, model)).toBe('string');
      }
    }
  });

  test('every model in provider list passes isModelForProvider', () => {
    for (const provider of ['claude', 'codex', 'gemini', 'deepagent'] as const) {
      const models = getProviderModels(provider);
      for (const model of models) {
        expect(isModelForProvider(provider, model)).toBe(true);
      }
    }
  });

  test('no model belongs to multiple providers', () => {
    const providers = ['claude', 'codex', 'gemini'] as const;
    for (let i = 0; i < providers.length; i++) {
      for (let j = i + 1; j < providers.length; j++) {
        const modelsA = getProviderModels(providers[i]);
        for (const model of modelsA) {
          expect(isModelForProvider(providers[j], model)).toBe(false);
        }
      }
    }
  });

  test('every provider with labels has matching model count', () => {
    for (const provider of ['claude', 'codex', 'gemini', 'deepagent'] as const) {
      const models = getProviderModels(provider);
      const labels = getProviderModelsWithLabels(provider);
      expect(labels).toHaveLength(models.length);
    }
  });
});
