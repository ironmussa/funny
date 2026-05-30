import { describe, expect, test } from 'vitest';

import { CLAUDE_SETTINGS_DEFAULT, claudeSettingsPathFromHome } from '@/lib/claude-settings';

describe('claude-settings', () => {
  test('claudeSettingsPathFromHome builds a POSIX path', () => {
    expect(claudeSettingsPathFromHome('/home/alice')).toBe('/home/alice/.claude/settings.json');
  });

  test('claudeSettingsPathFromHome builds a Windows path', () => {
    expect(claudeSettingsPathFromHome('C:\\Users\\alice')).toBe(
      'C:\\Users\\alice\\.claude\\settings.json',
    );
  });

  test('CLAUDE_SETTINGS_DEFAULT includes ENABLE_CLAUDEAI_MCP_SERVERS=false', () => {
    const parsed = JSON.parse(CLAUDE_SETTINGS_DEFAULT) as {
      env: { ENABLE_CLAUDEAI_MCP_SERVERS: string };
    };
    expect(parsed.env.ENABLE_CLAUDEAI_MCP_SERVERS).toBe('false');
  });
});
