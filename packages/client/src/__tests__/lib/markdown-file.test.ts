import { describe, expect, test } from 'vitest';

import { isMarkdownFile } from '@/lib/markdown-file';

describe('isMarkdownFile', () => {
  test.each(['README.md', 'guide.MDX', 'docs/reference.markdown'])(
    'recognizes the supported Markdown extension in %s',
    (filePath) => expect(isMarkdownFile(filePath)).toBe(true),
  );

  test.each(['README', 'notes.txt', 'docs/md'])('rejects non-Markdown path %s', (filePath) =>
    expect(isMarkdownFile(filePath)).toBe(false),
  );
});
