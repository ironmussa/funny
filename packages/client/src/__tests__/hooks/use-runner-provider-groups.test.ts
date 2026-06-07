import { describe, test, expect } from 'vitest';

import type { ModelGroup } from '@/hooks/use-acp-prompt-models';
import {
  applyRunnerProviderGroups,
  type RunnerProviderState,
} from '@/hooks/use-runner-provider-groups';
import type { AdvertisedProvider } from '@/lib/api/system';

const group = (provider: string): ModelGroup => ({
  provider,
  providerLabel: provider,
  models: [{ value: `${provider}:m1`, label: 'm1' }],
});

const BASE = [group('claude'), group('codex'), group('gemini')];

const state = (over: Partial<RunnerProviderState> = {}): RunnerProviderState => ({
  providers: [],
  activeBuiltins: null,
  availableProviders: null,
  hasRunner: true,
  ...over,
});

const byProvider = (groups: ModelGroup[]) => new Map(groups.map((g) => [g.provider, g]));

describe('applyRunnerProviderGroups (model-picker-availability §4)', () => {
  test('no runner → every group greyed with no-runner (incl. claude)', () => {
    const out = applyRunnerProviderGroups(BASE, state({ hasRunner: false }));
    expect(out).toHaveLength(3);
    for (const g of out) {
      expect(g.disabled).toBe(true);
      expect(g.disabledReason).toBe('no-runner');
      expect(g.models.every((m) => m.disabled)).toBe(true);
    }
  });

  test('runner online, availability unknown (null) → no gating (no regression)', () => {
    const out = applyRunnerProviderGroups(BASE, state({ hasRunner: true, availableProviders: null }));
    expect(out.every((g) => !g.disabled)).toBe(true);
  });

  test('active ∩ available enabled; active − available greyed not-installed', () => {
    const out = byProvider(
      applyRunnerProviderGroups(BASE, state({ availableProviders: ['claude', 'codex'] })),
    );
    expect(out.get('claude')?.disabled).toBeFalsy();
    expect(out.get('codex')?.disabled).toBeFalsy();
    expect(out.get('gemini')?.disabled).toBe(true);
    expect(out.get('gemini')?.disabledReason).toBe('not-installed');
    expect(out.get('gemini')?.models.every((m) => m.disabled)).toBe(true);
  });

  test('lean-core: inactive built-ins are hidden entirely (not greyed)', () => {
    const out = applyRunnerProviderGroups(
      BASE,
      state({ activeBuiltins: ['codex'], availableProviders: ['codex'] }),
    );
    const ids = out.map((g) => g.provider);
    expect(ids).toContain('claude'); // non-ACP built-in, always shown
    expect(ids).toContain('codex');
    expect(ids).not.toContain('gemini'); // gated off → hidden, not disabled
  });

  test('external advertised providers are appended and availability-gated', () => {
    const ext: AdvertisedProvider = {
      id: 'myagent',
      label: 'My Agent',
      models: { kind: 'dynamic', defaultModel: 'default' },
      attachmentLimits: { inlineMaxBytes: 1, uploadMaxBytes: 2, hardMaxBytes: 3 },
      auth: { mode: 'runner-preauth' },
    };
    const out = byProvider(
      applyRunnerProviderGroups(BASE, state({ providers: [ext], availableProviders: ['claude'] })),
    );
    expect(out.has('myagent')).toBe(true);
    expect(out.get('myagent')?.disabled).toBe(true); // advertised but not available
    expect(out.get('myagent')?.disabledReason).toBe('not-installed');
  });
});
