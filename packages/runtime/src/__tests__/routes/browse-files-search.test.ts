import { describe, expect, it } from 'vitest';

import { searchFilesAndFolders } from '../../routes/browse.js';

const FILES = [
  'src/components/Button.tsx',
  'src/components/Dialog.tsx',
  'src/components/forms/Input.tsx',
  'src/lib/utils.ts',
  'README.md',
];

describe('searchFilesAndFolders', () => {
  it('surfaces the matching directory itself, not only the files inside it', () => {
    const { files } = searchFilesAndFolders(FILES, 'components');

    // Regression: a query matching a directory name must yield a selectable
    // folder item, not just the files whose path happens to contain it.
    const folder = files.find((f) => f.type === 'folder' && f.path === 'src/components');
    expect(folder).toBeDefined();

    // The files inside still match too (their paths contain the query).
    expect(files.some((f) => f.type === 'file' && f.path === 'src/components/Button.tsx')).toBe(
      true,
    );
  });

  it('ranks the matching folder ahead of its equally-scored children', () => {
    const { files } = searchFilesAndFolders(FILES, 'forms');

    const folderIdx = files.findIndex(
      (f) => f.type === 'folder' && f.path === 'src/components/forms',
    );
    const childIdx = files.findIndex(
      (f) => f.type === 'file' && f.path === 'src/components/forms/Input.tsx',
    );

    expect(folderIdx).toBeGreaterThanOrEqual(0);
    expect(childIdx).toBeGreaterThanOrEqual(0);
    expect(folderIdx).toBeLessThan(childIdx);
  });

  it('derives every ancestor directory level', () => {
    const { files } = searchFilesAndFolders(FILES, 'src');
    const folders = files.filter((f) => f.type === 'folder').map((f) => f.path);
    expect(folders).toContain('src');
  });

  it('still returns files when the query only matches a filename', () => {
    const { files } = searchFilesAndFolders(FILES, 'readme');
    expect(files).toEqual([{ path: 'README.md', type: 'file' }]);
  });

  it('reports truncation past the limit', () => {
    const many = Array.from({ length: 10 }, (_, i) => `dir/file${i}.ts`);
    const { files, truncated } = searchFilesAndFolders(many, 'file', 3);
    expect(files).toHaveLength(3);
    expect(truncated).toBe(true);
  });
});
