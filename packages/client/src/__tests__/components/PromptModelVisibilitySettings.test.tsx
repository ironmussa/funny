import { describe, expect, test } from 'vitest';

import { getConfigurablePromptModelGroups } from '@/lib/prompt-model-visibility';
import type { ModelSelectGroup } from '@/lib/providers';

const group = (overrides: Partial<ModelSelectGroup>): ModelSelectGroup => ({
  provider: 'claude',
  providerLabel: 'Claude',
  models: [{ value: 'claude:sonnet', label: 'Sonnet' }],
  ...overrides,
});

describe('getConfigurablePromptModelGroups', () => {
  test('keeps only enabled providers with user-configurable models', () => {
    const out = getConfigurablePromptModelGroups([
      group({ provider: 'claude', providerLabel: 'Claude' }),
      group({
        provider: 'codex',
        providerLabel: 'Codex',
        disabled: true,
        disabledReason: 'not-installed',
        models: [{ value: 'codex:gpt-5.5', label: 'GPT-5.5', disabled: true }],
      }),
      group({
        provider: 'cursor',
        providerLabel: 'Cursor',
        models: [{ value: 'cursor:__loading__', label: 'Loading' }],
      }),
    ]);

    expect(out).toEqual([
      {
        provider: 'claude',
        providerLabel: 'Claude',
        models: [{ value: 'claude:sonnet', label: 'Sonnet' }],
      },
    ]);
  });
});
