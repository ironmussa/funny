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

import { removeSkill } from '../../services/skills-service.js';

describe('removeSkill — path-traversal guard (Security)', () => {
  beforeEach(() => {
    rmSync.mockClear();
    unlinkSync.mockClear();
    existsSync.mockClear();
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
