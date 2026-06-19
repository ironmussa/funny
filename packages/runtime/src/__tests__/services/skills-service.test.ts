import { describe, test, expect, vi, beforeEach } from 'vitest';

// Mock fs so removeSkill's filesystem calls are observable and never touch disk.
const { rmSync, unlinkSync, existsSync, readFileSync, readdirSync, writeFileSync } = vi.hoisted(
  () => ({
    rmSync: vi.fn(),
    unlinkSync: vi.fn(),
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => '{}'),
    readdirSync: vi.fn(() => []),
    writeFileSync: vi.fn(),
  }),
);

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    rmSync,
    unlinkSync,
    existsSync,
    readFileSync,
    readdirSync,
    writeFileSync,
  };
});

import {
  listCodexSkillResources,
  listProjectCommands,
  removeSkill,
} from '../../services/skills-service.js';

describe('listProjectCommands', () => {
  beforeEach(() => {
    rmSync.mockClear();
    unlinkSync.mockClear();
    existsSync.mockReset();
    readFileSync.mockReset();
    readdirSync.mockReset();
    existsSync.mockReturnValue(false);
    readFileSync.mockReturnValue('');
    readdirSync.mockReturnValue([]);
  });

  test('exposes nested .claude/commands using Claude namespace syntax', () => {
    existsSync.mockReturnValue(true);
    readdirSync.mockImplementation((path?: string) => {
      if (path?.endsWith('/.claude/commands')) {
        return [
          {
            name: 'opsx',
            isDirectory: () => true,
            isSymbolicLink: () => false,
            isFile: () => false,
          },
          {
            name: 'plain.md',
            isDirectory: () => false,
            isSymbolicLink: () => false,
            isFile: () => true,
          },
        ] as any;
      }
      if (path?.endsWith('/.claude/commands/opsx')) {
        return [
          {
            name: 'apply.md',
            isDirectory: () => false,
            isSymbolicLink: () => false,
            isFile: () => true,
          },
        ] as any;
      }
      return [];
    });
    readFileSync.mockImplementation((path?: string) => {
      if (path?.endsWith('/apply.md')) return '---\ndescription: Apply change\n---\n';
      return '';
    });

    expect(listProjectCommands('/project')).toEqual([
      {
        name: 'opsx:apply',
        description: 'Apply change',
        source: 'project',
        scope: 'project',
      },
      {
        name: 'plain',
        description: '',
        source: 'project',
        scope: 'project',
      },
    ]);
  });
});

describe('listCodexSkillResources', () => {
  beforeEach(() => {
    existsSync.mockReset();
    readFileSync.mockReset();
    readdirSync.mockReset();
    readFileSync.mockReturnValue('');
    readdirSync.mockReturnValue([]);
  });

  test('recursively finds Codex skills under ~/.codex/skills/.system/<skill>/SKILL.md', () => {
    // Codex nests built-in skills one level deeper (under `.system/`).
    existsSync.mockImplementation((p?: string) => {
      const s = String(p);
      if (s.endsWith('/.codex/skills')) return true; // root exists
      if (s.endsWith('/.system/imagegen/SKILL.md')) return true; // skill manifest
      return false; // no SKILL.md at intermediate dirs
    });
    readdirSync.mockImplementation((p?: string) => {
      const s = String(p);
      if (s.endsWith('/.codex/skills')) {
        return [{ name: '.system', isDirectory: () => true, isSymbolicLink: () => false }] as any;
      }
      if (s.endsWith('/.codex/skills/.system')) {
        return [{ name: 'imagegen', isDirectory: () => true, isSymbolicLink: () => false }] as any;
      }
      return [];
    });
    readFileSync.mockImplementation((p?: string) => {
      if (String(p).endsWith('/imagegen/SKILL.md')) {
        return '---\nname: imagegen\ndescription: Generate images\n---\n';
      }
      return '';
    });

    const resources = listCodexSkillResources();
    expect(resources).toHaveLength(1);
    expect(resources[0]).toMatchObject({
      kind: 'skill',
      name: 'imagegen',
      description: 'Generate images',
      origin: 'codex-global',
      compatibleProviders: ['codex'],
      scope: 'global',
    });
  });

  test('returns [] when ~/.codex/skills does not exist', () => {
    existsSync.mockReturnValue(false);
    expect(listCodexSkillResources()).toEqual([]);
  });

  test('also scans {project}/.codex/skills (project-scoped Codex skills)', () => {
    existsSync.mockImplementation((p?: string) => {
      const s = String(p);
      if (s.endsWith('/.codex/skills')) return true; // both home and project roots
      if (s.endsWith('/proj-skill/SKILL.md')) return true;
      return false;
    });
    readdirSync.mockImplementation((p?: string) => {
      const s = String(p);
      // Only the project root has a skill; home root is empty.
      if (s === '/repo/.codex/skills') {
        return [
          { name: 'proj-skill', isDirectory: () => true, isSymbolicLink: () => false },
        ] as any;
      }
      return [];
    });
    readFileSync.mockImplementation((p?: string) =>
      String(p).endsWith('/proj-skill/SKILL.md')
        ? '---\nname: proj-skill\ndescription: Project Codex skill\n---\n'
        : '',
    );

    const resources = listCodexSkillResources('/repo');
    const proj = resources.find((r) => r.name === 'proj-skill');
    expect(proj).toMatchObject({
      kind: 'skill',
      origin: 'codex-project',
      scope: 'project',
      compatibleProviders: ['codex'],
    });
  });
});

describe('removeSkill — path-traversal guard (Security)', () => {
  beforeEach(() => {
    rmSync.mockClear();
    unlinkSync.mockClear();
    existsSync.mockReset();
    existsSync.mockReturnValue(false);
  });

  test.each([
    '../../../.funny/encryption.key',
    '..',
    '../etc',
    'foo/bar',
    'foo\\bar',
    '.ssh',
    'a/../../b',
    '',
  ])('rejects traversal/invalid name %j without any fs deletion', (name) => {
    removeSkill(name);
    expect(rmSync).not.toHaveBeenCalled();
    expect(unlinkSync).not.toHaveBeenCalled();
    // The guard returns before even probing the filesystem.
    expect(existsSync).not.toHaveBeenCalled();
  });

  test('allows a well-formed skill name through to the fs layer', () => {
    removeSkill('my-skill_1');
    // existsSync is consulted for the skill dir / symlink once the name passes.
    expect(existsSync).toHaveBeenCalled();
  });
});
