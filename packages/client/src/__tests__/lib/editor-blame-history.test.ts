import { describe, expect, test } from 'vitest';

import type { BlameResponse, FileHistoryEntry } from '@/lib/api/system';
import {
  buildBlameHistoryEntries,
  buildFileHistoryEntries,
  formatBlameLineRanges,
} from '@/lib/editor-blame-history';

const blame: BlameResponse = {
  blamedLineCount: 5,
  hunks: [
    {
      startLine: 1,
      lineCount: 2,
      commitHash: 'aaa111',
      shortHash: 'aaa111',
      author: 'Ana',
      relativeDate: '2 days ago',
      summary: 'Add initial file',
    },
    {
      startLine: 3,
      lineCount: 1,
      commitHash: 'bbb222',
      shortHash: 'bbb222',
      author: 'Ben',
      relativeDate: '1 day ago',
      summary: 'Adjust behavior',
    },
    {
      startLine: 4,
      lineCount: 2,
      commitHash: 'aaa111',
      shortHash: 'aaa111',
      author: 'Ana',
      relativeDate: '2 days ago',
      summary: 'Add initial file',
    },
  ],
};

describe('buildBlameHistoryEntries', () => {
  test('groups hunks by commit while preserving first-seen order', () => {
    const entries = buildBlameHistoryEntries(blame, 'one\ntwo\nthree\nfour\nfive');

    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      commitHash: 'aaa111',
      author: 'Ana',
      lineCount: 4,
      ranges: [
        { startLine: 1, endLine: 2 },
        { startLine: 4, endLine: 5 },
      ],
      uncommitted: false,
    });
    expect(entries[1]).toMatchObject({
      commitHash: 'bbb222',
      author: 'Ben',
      lineCount: 1,
      ranges: [{ startLine: 3, endLine: 3 }],
    });
  });

  test('adds a working-tree entry for lines past the blamed HEAD version', () => {
    const entries = buildBlameHistoryEntries(blame, 'one\ntwo\nthree\nfour\nfive\nsix\nseven');

    expect(entries.at(-1)).toMatchObject({
      shortHash: 'worktree',
      author: 'You',
      lineCount: 2,
      ranges: [{ startLine: 6, endLine: 7 }],
      uncommitted: true,
    });
  });
});

describe('buildFileHistoryEntries', () => {
  test('uses git file history order while attaching current blame ranges', () => {
    const fileHistory: FileHistoryEntry[] = [
      {
        hash: 'ccc333',
        shortHash: 'ccc333',
        author: 'Cora',
        authorEmail: 'cora@example.test',
        relativeDate: '3 hours ago',
        message: 'Move file into src',
        status: 'renamed',
        path: 'src/example.ts',
        previousPath: 'example.ts',
      },
      {
        hash: 'aaa111',
        shortHash: 'aaa111',
        author: 'Ana',
        authorEmail: 'ana@example.test',
        relativeDate: '2 days ago',
        message: 'Add initial file',
        status: 'added',
        path: 'example.ts',
        previousPath: null,
      },
    ];

    const entries = buildFileHistoryEntries({
      blame,
      fileHistory,
      content: 'one\ntwo\nthree\nfour\nfive\nsix',
    });

    expect(entries.map((entry) => entry.commitHash)).toEqual([
      '__working_tree__',
      'ccc333',
      'aaa111',
      'bbb222',
    ]);
    expect(entries[1]).toMatchObject({
      status: 'renamed',
      path: 'src/example.ts',
      previousPath: 'example.ts',
      lineCount: 0,
      ranges: [],
    });
    expect(entries[2]).toMatchObject({
      summary: 'Add initial file',
      lineCount: 4,
      ranges: [
        { startLine: 1, endLine: 2 },
        { startLine: 4, endLine: 5 },
      ],
    });
  });
});

describe('formatBlameLineRanges', () => {
  test('formats compact range labels', () => {
    expect(
      formatBlameLineRanges([
        { startLine: 1, endLine: 1 },
        { startLine: 4, endLine: 8 },
        { startLine: 12, endLine: 12 },
        { startLine: 20, endLine: 22 },
      ]),
    ).toBe('L1, L4-L8, L12 +1');
  });
});
