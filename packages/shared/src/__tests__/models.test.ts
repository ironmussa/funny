import { describe, test, expect } from 'bun:test';

import {
  resolveModelId,
  getDefaultModel,
  getProviderModels,
  resolvePermissionMode,
  getDefaultAllowedTools,
  isModelForProvider,
} from '../models.js';

// ── resolveModelId ──────────────────────────────────────────────

describe('resolveModelId', () => {
  describe('claude provider', () => {
    test('resolves sonnet to its full model ID', () => {
      expect(resolveModelId('claude', 'sonnet')).toBe('claude-sonnet-4-5-20250929');
    });

    test('resolves opus to its full model ID', () => {
      expect(resolveModelId('claude', 'opus')).toBe('claude-opus-4-6');
    });

    test('resolves haiku to its full model ID', () => {
      expect(resolveModelId('claude', 'haiku')).toBe('claude-haiku-4-5-20251001');
    });

    test('throws on unknown claude model', () => {
      expect(() => resolveModelId('claude', 'o3' as any)).toThrow('Unknown Claude model: o3');
    });

    test('throws on codex model passed to claude', () => {
      expect(() => resolveModelId('claude', 'o4-mini' as any)).toThrow('Unknown Claude model');
    });
  });

  describe('codex provider', () => {
    test('resolves o3 to o3', () => {
      expect(resolveModelId('codex', 'o3')).toBe('o3');
    });

    test('resolves o4-mini to o4-mini', () => {
      expect(resolveModelId('codex', 'o4-mini')).toBe('o4-mini');
    });

    test('resolves codex-mini to codex-mini', () => {
      expect(resolveModelId('codex', 'codex-mini')).toBe('codex-mini');
    });

    test('throws on unknown codex model', () => {
      expect(() => resolveModelId('codex', 'sonnet' as any)).toThrow('Unknown Codex model: sonnet');
    });

    test('throws on claude model passed to codex', () => {
      expect(() => resolveModelId('codex', 'haiku' as any)).toThrow('Unknown Codex model');
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
  test('returns sonnet for claude', () => {
    expect(getDefaultModel('claude')).toBe('sonnet');
  });

  test('returns o4-mini for codex', () => {
    expect(getDefaultModel('codex')).toBe('o4-mini');
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
    expect(models).toContain('opus');
    expect(models).toContain('haiku');
    expect(models).toHaveLength(3);
  });

  test('returns all codex models', () => {
    const models = getProviderModels('codex');
    expect(models).toContain('o3');
    expect(models).toContain('o4-mini');
    expect(models).toContain('codex-mini');
    expect(models).toHaveLength(3);
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
      expect(isModelForProvider('claude', 'o3')).toBe(false);
      expect(isModelForProvider('claude', 'o4-mini')).toBe(false);
      expect(isModelForProvider('claude', 'codex-mini')).toBe(false);
    });
  });

  describe('codex provider', () => {
    test('returns true for o3', () => {
      expect(isModelForProvider('codex', 'o3')).toBe(true);
    });

    test('returns true for o4-mini', () => {
      expect(isModelForProvider('codex', 'o4-mini')).toBe(true);
    });

    test('returns true for codex-mini', () => {
      expect(isModelForProvider('codex', 'codex-mini')).toBe(true);
    });

    test('returns false for claude models', () => {
      expect(isModelForProvider('codex', 'sonnet')).toBe(false);
      expect(isModelForProvider('codex', 'opus')).toBe(false);
      expect(isModelForProvider('codex', 'haiku')).toBe(false);
    });
  });

  describe('unknown provider', () => {
    test('returns false for any model', () => {
      expect(isModelForProvider('external' as any, 'sonnet')).toBe(false);
      expect(isModelForProvider('unknown' as any, 'o3')).toBe(false);
    });
  });
});

// ── Cross-cutting consistency checks ────────────────────────────

describe('cross-cutting consistency', () => {
  test('default model for each provider is in its model list', () => {
    for (const provider of ['claude', 'codex'] as const) {
      const defaultModel = getDefaultModel(provider);
      const models = getProviderModels(provider);
      expect(models).toContain(defaultModel);
    }
  });

  test('every model in provider list can be resolved to an ID', () => {
    for (const provider of ['claude', 'codex'] as const) {
      const models = getProviderModels(provider);
      for (const model of models) {
        expect(() => resolveModelId(provider, model)).not.toThrow();
        expect(typeof resolveModelId(provider, model)).toBe('string');
      }
    }
  });

  test('every model in provider list passes isModelForProvider', () => {
    for (const provider of ['claude', 'codex'] as const) {
      const models = getProviderModels(provider);
      for (const model of models) {
        expect(isModelForProvider(provider, model)).toBe(true);
      }
    }
  });

  test('no model belongs to both providers', () => {
    const claudeModels = getProviderModels('claude');
    const codexModels = getProviderModels('codex');
    for (const model of claudeModels) {
      expect(isModelForProvider('codex', model)).toBe(false);
    }
    for (const model of codexModels) {
      expect(isModelForProvider('claude', model)).toBe(false);
    }
  });
});
