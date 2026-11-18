import { homedir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

import { claudeConfigJsonPath } from '../../utils/claude-profile-paths.js';

describe('claudeConfigJsonPath', () => {
  test('defaults to ~/.claude.json', () => {
    expect(claudeConfigJsonPath()).toBe(join(homedir(), '.claude.json'));
  });

  test('a profile config dir keeps .claude.json inside it, where the CLI writes it', () => {
    expect(claudeConfigJsonPath('/tmp/claude-work')).toBe('/tmp/claude-work/.claude.json');
    expect(claudeConfigJsonPath('~/.claude-work')).toBe(
      join(homedir(), '.claude-work/.claude.json'),
    );
  });
});
