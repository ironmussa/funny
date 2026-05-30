import { join } from 'path';

import { describe, expect, test } from 'vitest';

import { resolveClaudeHomeConfigScope } from '../../utils/claude-config-paths.js';

describe('resolveClaudeHomeConfigScope', () => {
  const home = '/home/tester';

  test('allows ~/.claude/settings.json', () => {
    const path = join(home, '.claude', 'settings.json');
    expect(resolveClaudeHomeConfigScope(path, home)).toEqual({
      scopeDir: join(home, '.claude'),
      configPath: path,
    });
  });

  test('allows ~/.claude/settings.local.json', () => {
    const path = join(home, '.claude', 'settings.local.json');
    expect(resolveClaudeHomeConfigScope(path, home)?.configPath).toBe(path);
  });

  test('rejects other files under ~/.claude', () => {
    expect(resolveClaudeHomeConfigScope(join(home, '.claude', 'other.json'), home)).toBeNull();
  });

  test('rejects paths outside home', () => {
    expect(resolveClaudeHomeConfigScope('/etc/passwd', home)).toBeNull();
  });
});
