import { describe, expect, test } from 'bun:test';

import {
  buildFileTreeRows,
  collectFileTreeFolders,
  filterFilePaths,
  normalizeFilePaths,
} from '../file-tree-model';

const files = ['src/main.ts', 'README.md', 'src/components/Button.tsx', 'src/app.ts'];

describe('native file tree model', () => {
  test('normalizes separators, duplicates, and traversal entries', () => {
    expect(normalizeFilePaths(['src\\app.ts', '/src/app.ts/', '../secret', 'README.md'])).toEqual([
      'README.md',
      'src/app.ts',
    ]);
  });

  test('renders folders before files with stable depth-first rows', () => {
    expect(buildFileTreeRows(files, new Set()).map((row) => `${row.kind}:${row.path}`)).toEqual([
      'folder:src',
      'folder:src/components',
      'file:src/components/Button.tsx',
      'file:src/app.ts',
      'file:src/main.ts',
      'file:README.md',
    ]);
  });

  test('hides descendants of collapsed folders', () => {
    expect(buildFileTreeRows(files, new Set(['src'])).map((row) => row.path)).toEqual([
      'src',
      'README.md',
    ]);
  });

  test('filters paths case-insensitively and derives all folder paths', () => {
    expect(filterFilePaths(files, 'BUTTON')).toEqual(['src/components/Button.tsx']);
    expect([...collectFileTreeFolders(files)].sort()).toEqual(['src', 'src/components']);
  });
});
