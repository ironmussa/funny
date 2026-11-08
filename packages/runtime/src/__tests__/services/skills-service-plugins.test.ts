import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  listCustomCommandResourcesForProvider,
  listPluginCommands,
  listSkillResourcesForProvider,
} from '../../services/skills-service.js';

let configDir: string;

function write(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function skillMd(name: string, description: string) {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\nBody\n`;
}

/** Install a fake plugin under the temp Claude config dir. */
function installPlugin(key: string, files: Record<string, string>) {
  const installPath = join(configDir, 'plugins', 'cache', key);
  for (const [rel, content] of Object.entries(files)) write(join(installPath, rel), content);
  return installPath;
}

function writeInstalled(plugins: Record<string, string>) {
  write(
    join(configDir, 'plugins', 'installed_plugins.json'),
    JSON.stringify({
      version: 2,
      plugins: Object.fromEntries(
        Object.entries(plugins).map(([key, installPath]) => [key, [{ installPath }]]),
      ),
    }),
  );
}

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'funny-plugins-'));
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

describe('plugin skills and commands', () => {
  test('finds skills declared in plugin.json under a nested layout', () => {
    const installPath = installPlugin('nested', {
      '.claude-plugin/plugin.json': JSON.stringify({
        name: 'mattpocock-skills',
        skills: ['./skills/engineering/implement', './skills/engineering/tdd'],
      }),
      'skills/engineering/implement/SKILL.md': skillMd('implement', 'Implement a spec'),
      'skills/engineering/tdd/SKILL.md': skillMd('tdd', 'Test-driven development'),
    });
    writeInstalled({ 'mattpocock-skills@claude-plugins-official': installPath });

    const names = listPluginCommands({ claudeConfigDir: configDir }).map((s) => s.name);
    expect(names.sort()).toEqual(['mattpocock-skills:implement', 'mattpocock-skills:tdd']);

    const resources = listSkillResourcesForProvider('claude', undefined, {
      claudeConfigDir: configDir,
    }).filter((r) => r.origin === 'claude-plugin');
    expect(resources.map((r) => [r.kind, r.name, r.description]).sort()).toEqual([
      ['skill', 'mattpocock-skills:implement', 'Implement a spec'],
      ['skill', 'mattpocock-skills:tdd', 'Test-driven development'],
    ]);
  });

  test('finds skills in a manifest folder of skill dirs, without duplicates', () => {
    const installPath = installPlugin('grouped', {
      '.claude-plugin/plugin.json': JSON.stringify({
        name: 'grouped',
        skills: ['./skills/engineering', './skills/engineering/implement'],
      }),
      'skills/engineering/implement/SKILL.md': skillMd('implement', 'Implement'),
      'skills/engineering/review/SKILL.md': skillMd('review', 'Review'),
    });
    writeInstalled({ 'grouped@market': installPath });

    const names = listPluginCommands({ claudeConfigDir: configDir }).map((s) => s.name);
    expect(names.sort()).toEqual(['grouped:implement', 'grouped:review']);
  });

  test('keeps the default commands/ and skills/ folders and adds manifest commands', () => {
    const installPath = installPlugin('flat', {
      '.claude-plugin/plugin.json': JSON.stringify({
        name: 'flat',
        commands: ['./extra/ship.md', './more'],
      }),
      'commands/commit.md': '---\ndescription: Commit\n---\n',
      'extra/ship.md': '---\ndescription: Ship it\n---\n',
      'more/release.md': '---\ndescription: Release\n---\n',
      'skills/plan/SKILL.md': skillMd('plan', 'Plan'),
    });
    writeInstalled({ 'flat@market': installPath });

    const names = listPluginCommands({ claudeConfigDir: configDir }).map((s) => s.name);
    expect(names.sort()).toEqual(['flat:commit', 'flat:plan', 'flat:release', 'flat:ship']);

    const commands = listCustomCommandResourcesForProvider('claude', undefined, {
      claudeConfigDir: configDir,
    }).filter((r) => r.origin === 'claude-plugin');
    expect(commands.map((r) => r.name).sort()).toEqual([
      'flat:commit',
      'flat:release',
      'flat:ship',
    ]);
  });
});
