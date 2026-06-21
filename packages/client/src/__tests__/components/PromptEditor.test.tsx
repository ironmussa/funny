import { describe, expect, test } from 'vitest';

import {
  buildSlashSuggestionItems,
  getSuggestionLoadingLabel,
} from '@/components/prompt-editor/PromptEditor';

describe('buildSlashSuggestionItems', () => {
  test('returns SDK slash commands before skills have loaded', () => {
    const items = buildSlashSuggestionItems({
      skills: [],
      sdkCommands: ['compact', 'init'],
      query: '',
      commandProvider: 'claude',
    });

    expect(items.map((item) => item.id)).toEqual(['compact', 'init']);
    expect(items[0].description).toBe('Summarize the conversation to free up context');
  });

  test('dedupes skills and SDK commands while preserving skill descriptions', () => {
    const items = buildSlashSuggestionItems({
      skills: [{ name: 'fix-linear', description: 'Fix a Linear issue' }],
      sdkCommands: ['fix-linear', 'review'],
      query: 'fix',
      commandProvider: 'codex',
    });

    expect(items).toEqual([
      {
        id: 'fix-linear',
        label: 'fix-linear',
        description: 'Fix a Linear issue',
        type: 'slash',
      },
    ]);
  });

  test('uses a generic loading label for slash suggestions', () => {
    expect(getSuggestionLoadingLabel('slash')).toEqual({
      key: 'prompt.loadingCommands',
      fallback: 'Loading commands...',
    });
  });
});
