import { beforeEach, describe, expect, test, vi } from 'vitest';

const h = vi.hoisted(() => ({ readdir: vi.fn() }));
vi.mock('fs/promises', () => ({ readdir: h.readdir }));
vi.mock('@funny/core/git', () => ({ getNativeGit: vi.fn(), gitRead: vi.fn() }));
vi.mock('../../lib/logger.js', () => ({ log: { warn: vi.fn() } }));
vi.mock('../../lib/telemetry.js', () => ({
  startSpan: () => ({ attributes: {}, end: vi.fn() }),
}));

import { walkDirectoryTree } from '../../utils/git-files.js';

function entry(name: string, kind: 'directory' | 'file' | 'link') {
  return {
    name,
    isDirectory: () => kind === 'directory',
    isFile: () => kind === 'file',
    isSymbolicLink: () => kind === 'link',
  };
}

describe('walkDirectoryTree concurrency', () => {
  beforeEach(() => vi.clearAllMocks());

  test('bounds reads across simultaneous nested walks and releases failed reads', async () => {
    let active = 0;
    let peak = 0;
    h.readdir.mockImplementation(async (dir: string) => {
      active++;
      peak = Math.max(peak, active);
      try {
        await new Promise((resolve) => setTimeout(resolve, 1));
        if (dir.endsWith('/blocked')) throw new Error('EACCES');
        if (dir === '/a' || dir === '/b') {
          return [
            ...Array.from({ length: 40 }, (_, i) => entry('dir' + i, 'directory')),
            entry('blocked', 'directory'),
            entry('node_modules', 'directory'),
            entry('link', 'link'),
          ];
        }
        if (!dir.endsWith('/nested')) return [entry('nested', 'directory')];
        return [entry('file.ts', 'file')];
      } finally {
        active--;
      }
    });
    const results = await Promise.all([walkDirectoryTree('/a'), walkDirectoryTree('/b')]);
    const expected = Array.from({ length: 40 }, (_, i) => 'dir' + i + '/nested/file.ts').sort();
    expect(results).toEqual([expected, expected]);
    expect(peak).toBeLessThanOrEqual(16);
    expect(peak).toBeGreaterThan(1);
    expect(active).toBe(0);
    expect(h.readdir.mock.calls.some(([dir]) => /node_modules|link/.test(dir))).toBe(false);
    expect(await walkDirectoryTree('/a')).toEqual(expected);
  });
});
