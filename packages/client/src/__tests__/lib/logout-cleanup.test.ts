import { PREFERENCE_KEYS } from '@funny/client-core';
import { beforeEach, describe, expect, test } from 'vitest';

import { clearUserClientState } from '@/lib/logout-cleanup';

describe('clearUserClientState', () => {
  beforeEach(() => localStorage.clear());

  test('removes what the previous user left behind', () => {
    localStorage.setItem('funny-terminal-store', '{"state":{"tabs":[{"threadId":"t1"}]}}');
    localStorage.setItem('funny_last_route', '/projects/p1/threads/t1');
    localStorage.setItem('funny:contextUsage:t1', '{"used":1}');
    localStorage.setItem('funny:grid-cells:v1', '{"0":"t1"}');
    localStorage.setItem('funny_expanded_projects', '["p1"]');
    localStorage.setItem('browser_panel_history', '["https://example.com/private"]');
    localStorage.setItem('funny:last-browse-path', '/home/alice/secret');
    localStorage.setItem(PREFERENCE_KEYS.hiddenPromptModels, '["claude:opus"]');
    localStorage.setItem('some-key-added-later', 'x');

    clearUserClientState(localStorage);

    expect(localStorage.length).toBe(0);
  });

  test('keeps the device preferences', () => {
    const kept: Record<string, string> = {
      theme: 'dark',
      [PREFERENCE_KEYS.fontSize]: 'large',
      [PREFERENCE_KEYS.threadViewer]: 'frozen',
      [PREFERENCE_KEYS.notificationsEnabled]: '1',
      [PREFERENCE_KEYS.notificationSoundEnabled]: '0',
      'funny:setupCompleted': 'true',
      'funny:log-level': 'debug',
      'funny:log-ns:auth-store': 'trace',
    };
    for (const [key, value] of Object.entries(kept)) localStorage.setItem(key, value);
    localStorage.setItem('funny-terminal-store', '{}');

    clearUserClientState(localStorage);

    expect(Object.fromEntries(Object.keys(kept).map((k) => [k, localStorage.getItem(k)]))).toEqual(
      kept,
    );
    expect(localStorage.length).toBe(Object.keys(kept).length);
  });
});
