import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { syncClaudeProjectAssets } from '../ports/index.js';

describe('syncClaudeProjectAssets', () => {
  let root: string;
  let project: string;
  let worktree: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sync-assets-'));
    project = join(root, 'project');
    worktree = join(root, 'worktree');
    // A skill kept in .agents/skills and linked from .claude/skills, as `npx skills` installs it.
    mkdirSync(join(project, '.agents/skills/gdp-ts'), { recursive: true });
    writeFileSync(join(project, '.agents/skills/gdp-ts/SKILL.md'), '# gdp-ts');
    mkdirSync(join(project, '.claude/skills/local'), { recursive: true });
    writeFileSync(join(project, '.claude/skills/local/SKILL.md'), '# local');
    symlinkSync('../../.agents/skills/gdp-ts', join(project, '.claude/skills/gdp-ts'));
    mkdirSync(worktree, { recursive: true });
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test('links the symlinked skill into the worktree', () => {
    syncClaudeProjectAssets(project, worktree);
    expect(readFileSync(join(worktree, '.claude/skills/gdp-ts/SKILL.md'), 'utf8')).toBe('# gdp-ts');
  });

  // A factory run prepares its worktree again on every step: the second sync
  // threw EINVAL ("cannot copy … to a subdirectory of self") on the link the
  // first one made, and stopped copying the rest.
  test('syncs again into a worktree it already synced', () => {
    syncClaudeProjectAssets(project, worktree);
    writeFileSync(join(project, '.claude/skills/local/SKILL.md'), '# local, edited');

    expect(() => syncClaudeProjectAssets(project, worktree)).not.toThrow();
    expect(readFileSync(join(worktree, '.claude/skills/local/SKILL.md'), 'utf8')).toBe(
      '# local, edited',
    );
    expect(realpathSync(join(worktree, '.claude/skills/gdp-ts'))).toBe(
      realpathSync(join(project, '.agents/skills/gdp-ts')),
    );
  });
});
