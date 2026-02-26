import { describe, test, expect } from 'vitest';

import { parseReferencedFiles } from '@/lib/parse-referenced-files';

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
      expect(result.files).toEqual(['src/index.ts']);
      expect(result.cleanContent).toBe('Please review this file.');
    });

    test('extracts file with self-closing tag', () => {
      const content =
        '<referenced-files>\n<file path="README.md" />\n</referenced-files>\nCheck readme.';
      const result = parseReferencedFiles(content);
      expect(result.files).toEqual(['README.md']);
    });

    test('extracts file with non-self-closing tag', () => {
      const content =
        '<referenced-files>\n<file path="test.ts"></file>\n</referenced-files>\nContent here.';
      const result = parseReferencedFiles(content);
      // The regex uses [^>]* after the path, so the > closing the tag is matched
      expect(result.files).toEqual(['test.ts']);
    });
  });

  describe('multiple file references', () => {
    test('extracts multiple file paths', () => {
      const content =
        '<referenced-files>\n<file path="src/a.ts" />\n<file path="src/b.ts" />\n<file path="src/c.ts" />\n</referenced-files>\nReview these files.';
      const result = parseReferencedFiles(content);
      expect(result.files).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts']);
      expect(result.cleanContent).toBe('Review these files.');
    });

    test('extracts files on same line', () => {
      const content =
        '<referenced-files><file path="a.ts" /><file path="b.ts" /></referenced-files>Content';
      const result = parseReferencedFiles(content);
      expect(result.files).toEqual(['a.ts', 'b.ts']);
      expect(result.cleanContent).toBe('Content');
    });

    test('preserves file order', () => {
      const content =
        '<referenced-files>\n<file path="z.ts" />\n<file path="a.ts" />\n<file path="m.ts" />\n</referenced-files>\nDone.';
      const result = parseReferencedFiles(content);
      expect(result.files).toEqual(['z.ts', 'a.ts', 'm.ts']);
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
      expect(result.files).toEqual(['x.ts']);
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
      expect(result.files).toEqual(['x.ts']);
      expect(result.cleanContent).toBe('Content');
    });
  });

  describe('file paths with special characters', () => {
    test('handles paths with spaces', () => {
      const content =
        '<referenced-files>\n<file path="src/my file.ts" />\n</referenced-files>\nContent';
      const result = parseReferencedFiles(content);
      expect(result.files).toEqual(['src/my file.ts']);
    });

    test('handles paths with dots', () => {
      const content =
        '<referenced-files>\n<file path="src/.env.local" />\n</referenced-files>\nContent';
      const result = parseReferencedFiles(content);
      expect(result.files).toEqual(['src/.env.local']);
    });

    test('handles deep nested paths', () => {
      const content =
        '<referenced-files>\n<file path="packages/server/src/utils/git-v2.ts" />\n</referenced-files>\nContent';
      const result = parseReferencedFiles(content);
      expect(result.files).toEqual(['packages/server/src/utils/git-v2.ts']);
    });

    test('handles Windows-style paths', () => {
      const content =
        '<referenced-files>\n<file path="C:\\Users\\test\\file.ts" />\n</referenced-files>\nContent';
      const result = parseReferencedFiles(content);
      expect(result.files).toEqual(['C:\\Users\\test\\file.ts']);
    });

    test('handles paths with hyphens and underscores', () => {
      const content =
        '<referenced-files>\n<file path="my-project/some_file.test.ts" />\n</referenced-files>\nContent';
      const result = parseReferencedFiles(content);
      expect(result.files).toEqual(['my-project/some_file.test.ts']);
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

  describe('edge cases', () => {
    test('handles file tag with additional attributes', () => {
      const content =
        '<referenced-files>\n<file path="src/a.ts" line="10" />\n</referenced-files>\nContent';
      const result = parseReferencedFiles(content);
      expect(result.files).toEqual(['src/a.ts']);
    });

    test('handles compact block on single line', () => {
      const content = '<referenced-files><file path="a.ts" /></referenced-files>Content';
      const result = parseReferencedFiles(content);
      expect(result.files).toEqual(['a.ts']);
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
