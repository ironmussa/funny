import { describe, expect, it } from 'vitest';

import { searchFilesAndFolders } from '../../routes/browse.js';

const FILES = [
  'src/components/Button.tsx',
  'src/components/Dialog.tsx',
  'src/lib/utils.ts',
  'src/lib/auth/session.ts',
  'README.md',
];

describe('searchFilesAndFolders', () => {
  it('surfaces the matching directory itself, not only the files inside it', () => {
    const { files } = searchFilesAndFolders(FILES, 'components');

    // Regression: the directory `src/components` must appear as a selectable
    // folder item. Previously only the files inside it were returned because
    // their path contained the query.
    const folder = files.find((f) => f.type === 'folder' && f.path === 'src/components');
    expect(folder).toBeDefined();
  });

  it('ranks the folder ahead of its children for an exact directory-name query', () => {
    const { files } = searchFilesAndFolders(FILES, 'components');
    const folderIdx = files.findIndex((f) => f.type === 'folder' && f.path === 'src/components');
    const firstChildIdx = files.findIndex((f) => f.path.startsWith('src/components/'));
    expect(folderIdx).toBeGreaterThanOrEqual(0);
    expect(folderIdx).toBeLessThan(firstChildIdx);
  });

  it('derives every ancestor directory from the file paths', () => {
    const { files } = searchFilesAndFolders(FILES, 'auth');
    const folder = files.find((f) => f.type === 'folder' && f.path === 'src/lib/auth');
    expect(folder).toBeDefined();
  });

  it('still returns matching files', () => {
    const { files } = searchFilesAndFolders(FILES, 'button');
    expect(files.some((f) => f.type === 'file' && f.path === 'src/components/Button.tsx')).toBe(
      true,
    );
  });

  it('reports truncation past the limit', () => {
    const many = Array.from({ length: 10 }, (_, i) => `dir${i}/match.ts`);
    const { files, truncated } = searchFilesAndFolders(many, 'match', 5);
    expect(files).toHaveLength(5);
    expect(truncated).toBe(true);
  });
});
