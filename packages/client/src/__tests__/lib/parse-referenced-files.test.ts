import { describe, test, expect } from 'vitest';

import { parseReferencedFiles } from '@/lib/parse-referenced-files';

/** Helper: wrap a path string into a file ReferencedItem */
const f = (path: string) => ({ path, type: 'file' as const });

describe('parseReferencedFiles', () => {
  describe('no referenced files block', () => {
    test('returns empty files and original content when no block present', () => {
      const content = 'Hello, this is a regular message.';
      const result = parseReferencedFiles(content);
      expect(result.files).toEqual([]);
      expect(result.cleanContent).toBe(content);
    });

    test('returns empty files for empty string', () => {
      const result = parseReferencedFiles('');
      expect(result.files).toEqual([]);
      expect(result.cleanContent).toBe('');
    });

    test('returns empty files when block is malformed', () => {
      const content = '<referenced-files>unclosed block\nSome content';
      const result = parseReferencedFiles(content);
      expect(result.files).toEqual([]);
      expect(result.cleanContent).toBe(content);
    });

    test('returns empty files when only closing tag present', () => {
      const content = '</referenced-files>\nSome content';
      const result = parseReferencedFiles(content);
      expect(result.files).toEqual([]);
      expect(result.cleanContent).toBe(content);
    });
  });

  describe('single file reference', () => {
    test('extracts single file path', () => {
      const content =
        '<referenced-files>\n<file path="src/index.ts" />\n</referenced-files>\nPlease review this file.';
      const result = parseReferencedFiles(content);
      expect(result.files).toEqual([f('src/index.ts')]);
      expect(result.cleanContent).toBe('Please review this file.');
    });

    test('extracts file with self-closing tag', () => {
      const content =
        '<referenced-files>\n<file path="README.md" />\n</referenced-files>\nCheck readme.';
      const result = parseReferencedFiles(content);
      expect(result.files).toEqual([f('README.md')]);
    });

    test('extracts file with non-self-closing tag', () => {
      const content =
        '<referenced-files>\n<file path="test.ts"></file>\n</referenced-files>\nContent here.';
      const result = parseReferencedFiles(content);
      // The regex uses [^>]* after the path, so the > closing the tag is matched
      expect(result.files).toEqual([f('test.ts')]);
    });
  });

  describe('multiple file references', () => {
    test('extracts multiple file paths', () => {
      const content =
        '<referenced-files>\n<file path="src/a.ts" />\n<file path="src/b.ts" />\n<file path="src/c.ts" />\n</referenced-files>\nReview these files.';
      const result = parseReferencedFiles(content);
      expect(result.files).toEqual([f('src/a.ts'), f('src/b.ts'), f('src/c.ts')]);
      expect(result.cleanContent).toBe('Review these files.');
    });

    test('extracts files on same line', () => {
      const content =
        '<referenced-files><file path="a.ts" /><file path="b.ts" /></referenced-files>Content';
      const result = parseReferencedFiles(content);
      expect(result.files).toEqual([f('a.ts'), f('b.ts')]);
      expect(result.cleanContent).toBe('Content');
    });

    test('preserves file order', () => {
      const content =
        '<referenced-files>\n<file path="z.ts" />\n<file path="a.ts" />\n<file path="m.ts" />\n</referenced-files>\nDone.';
      const result = parseReferencedFiles(content);
      expect(result.files).toEqual([f('z.ts'), f('a.ts'), f('m.ts')]);
    });
  });

  describe('clean content after XML block', () => {
    test('returns content after the block without leading whitespace from block', () => {
      const content =
        '<referenced-files>\n<file path="x.ts" />\n</referenced-files>\nThe rest of the message.';
      const result = parseReferencedFiles(content);
      expect(result.cleanContent).toBe('The rest of the message.');
    });

    test('preserves all content after the block', () => {
      const content =
        '<referenced-files>\n<file path="x.ts" />\n</referenced-files>\nLine 1\nLine 2\nLine 3';
      const result = parseReferencedFiles(content);
      expect(result.cleanContent).toBe('Line 1\nLine 2\nLine 3');
    });

    test('handles block with trailing whitespace before content', () => {
      const content =
        '<referenced-files>\n<file path="x.ts" />\n</referenced-files>   \nContent after spaces.';
      const result = parseReferencedFiles(content);
      expect(result.cleanContent).toContain('Content after spaces.');
    });

    test('returns empty clean content when nothing follows the block', () => {
      const content = '<referenced-files>\n<file path="x.ts" />\n</referenced-files>';
      const result = parseReferencedFiles(content);
      expect(result.files).toEqual([f('x.ts')]);
      expect(result.cleanContent).toBe('');
    });
  });

  describe('XML block at start only', () => {
    test('ignores referenced-files block in the middle of content', () => {
      const content =
        'Some preamble text.\n<referenced-files>\n<file path="src/index.ts" />\n</referenced-files>\nMore text.';
      const result = parseReferencedFiles(content);
      expect(result.files).toEqual([]);
      expect(result.cleanContent).toBe(content);
    });

    test('ignores referenced-files block at the end of content', () => {
      const content =
        'Some text.\n<referenced-files>\n<file path="src/index.ts" />\n</referenced-files>';
      const result = parseReferencedFiles(content);
      expect(result.files).toEqual([]);
      expect(result.cleanContent).toBe(content);
    });

    test('allows leading whitespace before the block', () => {
      const content = '  \n<referenced-files>\n<file path="x.ts" />\n</referenced-files>\nContent';
      const result = parseReferencedFiles(content);
      expect(result.files).toEqual([f('x.ts')]);
      expect(result.cleanContent).toBe('Content');
    });
  });

  describe('file paths with special characters', () => {
    test('handles paths with spaces', () => {
      const content =
        '<referenced-files>\n<file path="src/my file.ts" />\n</referenced-files>\nContent';
      const result = parseReferencedFiles(content);
      expect(result.files).toEqual([f('src/my file.ts')]);
    });

    test('handles paths with dots', () => {
      const content =
        '<referenced-files>\n<file path="src/.env.local" />\n</referenced-files>\nContent';
      const result = parseReferencedFiles(content);
      expect(result.files).toEqual([f('src/.env.local')]);
    });

    test('handles deep nested paths', () => {
      const content =
        '<referenced-files>\n<file path="packages/runtime/src/utils/git-v2.ts" />\n</referenced-files>\nContent';
      const result = parseReferencedFiles(content);
      expect(result.files).toEqual([f('packages/runtime/src/utils/git-v2.ts')]);
    });

    test('handles Windows-style paths', () => {
      const content =
        '<referenced-files>\n<file path="C:\\Users\\test\\file.ts" />\n</referenced-files>\nContent';
      const result = parseReferencedFiles(content);
      expect(result.files).toEqual([f('C:\\Users\\test\\file.ts')]);
    });

    test('handles paths with hyphens and underscores', () => {
      const content =
        '<referenced-files>\n<file path="my-project/some_file.test.ts" />\n</referenced-files>\nContent';
      const result = parseReferencedFiles(content);
      expect(result.files).toEqual([f('my-project/some_file.test.ts')]);
    });
  });

  describe('empty file block', () => {
    test('returns empty files for block with no file tags', () => {
      const content = '<referenced-files>\n</referenced-files>\nSome content.';
      const result = parseReferencedFiles(content);
      expect(result.files).toEqual([]);
      expect(result.cleanContent).toBe('Some content.');
    });

    test('returns empty files for block with only whitespace', () => {
      const content = '<referenced-files>   \n   \n</referenced-files>\nContent.';
      const result = parseReferencedFiles(content);
      expect(result.files).toEqual([]);
      expect(result.cleanContent).toBe('Content.');
    });

    test('returns empty files for block with non-file XML', () => {
      const content =
        '<referenced-files>\n<other-tag>text</other-tag>\n</referenced-files>\nContent.';
      const result = parseReferencedFiles(content);
      expect(result.files).toEqual([]);
    });
  });

  describe('folder references', () => {
    test('extracts folder as a single item instead of expanding files', () => {
      const content =
        '<referenced-files>\n<folder path="docs">\n<file path="docs/readme.md">\ncontent\n</file>\n<file path="docs/guide.md">\ncontent\n</file>\n</folder>\n</referenced-files>\nCheck this folder.';
      const result = parseReferencedFiles(content);
      expect(result.files).toEqual([{ path: 'docs', type: 'folder' }]);
      expect(result.cleanContent).toBe('Check this folder.');
    });

    test('extracts folder with note attribute', () => {
      const content =
        '<referenced-files>\n<folder path="src" note="Showing 50 of 120 files.">\n<file path="src/a.ts">\ncontent\n</file>\n</folder>\n</referenced-files>\nContent';
      const result = parseReferencedFiles(content);
      expect(result.files).toEqual([{ path: 'src', type: 'folder' }]);
    });

    test('extracts mix of folders and standalone files', () => {
      const content =
        '<referenced-files>\n<folder path="docs">\n<file path="docs/a.md">\ncontent\n</file>\n</folder>\n<file path="README.md" />\n</referenced-files>\nContent';
      const result = parseReferencedFiles(content);
      expect(result.files).toEqual([
        { path: 'docs', type: 'folder' },
        { path: 'README.md', type: 'file' },
      ]);
    });

    test('does not count files inside folders as standalone files', () => {
      const content =
        '<referenced-files>\n<folder path="src">\n<file path="src/index.ts">\ncode\n</file>\n<file path="src/utils.ts">\ncode\n</file>\n</folder>\n</referenced-files>\nContent';
      const result = parseReferencedFiles(content);
      expect(result.files).toHaveLength(1);
      expect(result.files[0]).toEqual({ path: 'src', type: 'folder' });
    });
  });

  describe('edge cases', () => {
    test('handles file tag with additional attributes', () => {
      const content =
        '<referenced-files>\n<file path="src/a.ts" line="10" />\n</referenced-files>\nContent';
      const result = parseReferencedFiles(content);
      expect(result.files).toEqual([f('src/a.ts')]);
    });

    test('handles compact block on single line', () => {
      const content = '<referenced-files><file path="a.ts" /></referenced-files>Content';
      const result = parseReferencedFiles(content);
      expect(result.files).toEqual([f('a.ts')]);
      expect(result.cleanContent).toBe('Content');
    });

    test('does not extract file tags outside referenced-files block', () => {
      const content = '<file path="outside.ts" />\nSome text.';
      const result = parseReferencedFiles(content);
      expect(result.files).toEqual([]);
      expect(result.cleanContent).toBe(content);
    });
  });
});
