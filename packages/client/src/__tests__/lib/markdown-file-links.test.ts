import { describe, expect, test } from 'vitest';

import {
  getMarkdownFileLinkPath,
  isLikelyMarkdownFilePath,
  markdownFileBasePath,
  resolveMarkdownFilePath,
} from '@/lib/markdown-file-links';

describe('markdown file links', () => {
  test('uses the href when markdown link text is only a file name', () => {
    expect(
      getMarkdownFileLinkPath(
        '/home/u/projects/funny/packages/client/src/components/thread/MessageContent.tsx:42',
        'MessageContent.tsx',
      ),
    ).toBe('/home/u/projects/funny/packages/client/src/components/thread/MessageContent.tsx:42');
  });

  test('recognizes repo-relative file hrefs', () => {
    expect(
      getMarkdownFileLinkPath('packages/client/src/lib/editor-utils.ts', 'editor-utils.ts'),
    ).toBe('packages/client/src/lib/editor-utils.ts');
  });

  test('recognizes bare file names emitted as links', () => {
    expect(getMarkdownFileLinkPath('agent-job-manager.ts', 'agent-job-manager.ts')).toBe(
      'agent-job-manager.ts',
    );
  });

  test('does not treat web, anchor, or app-route links as local files', () => {
    expect(getMarkdownFileLinkPath('https://example.com/a.ts', 'a.ts')).toBeNull();
    expect(getMarkdownFileLinkPath('#section', 'section')).toBeNull();
    expect(isLikelyMarkdownFilePath('/projects/p1/threads/t1')).toBe(false);
  });

  test('resolves relative links against the active project path', () => {
    expect(
      resolveMarkdownFilePath(
        'packages/client/src/components/thread/MessageContent.tsx:42',
        '/home/u/projects/funny',
      ),
    ).toBe('/home/u/projects/funny/packages/client/src/components/thread/MessageContent.tsx:42');
  });

  test('keeps absolute paths unchanged', () => {
    expect(resolveMarkdownFilePath('/home/u/project/file.ts:7', '/home/u/projects/funny')).toBe(
      '/home/u/project/file.ts:7',
    );
  });
});

describe('markdownFileBasePath', () => {
  test("resolves a file's relative links against its own folder", () => {
    const base = markdownFileBasePath('/home/u/.claude/memory/dependency-updates.md');
    expect(base).toBe('/home/u/.claude/memory');
    expect(resolveMarkdownFilePath('fresh-worktree.md', base)).toBe(
      '/home/u/.claude/memory/fresh-worktree.md',
    );
  });

  test('handles Windows separators, the root and bare names', () => {
    expect(markdownFileBasePath('C:\\notes\\a.md')).toBe('C:/notes');
    expect(markdownFileBasePath('/a.md')).toBe('/');
    expect(markdownFileBasePath('a.md')).toBeNull();
  });
});
