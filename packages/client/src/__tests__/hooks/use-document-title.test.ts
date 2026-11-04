import { describe, expect, test } from 'vitest';

import { branchForDocumentTitle, formatDocumentTitle } from '@/hooks/use-document-title';

describe('formatDocumentTitle', () => {
  test('scratch title drops the attachments block', () => {
    const title =
      '<referenced-files>\n<file path="nota-a.md">\n# Nota A\n</file>\n</referenced-files>\n\nPrueba de adjuntos';
    expect(formatDocumentTitle({ isScratchThread: true, scratchTitle: title })).toBe(
      'Prueba de adjuntos — funny',
    );
  });

  test('project with branch', () => {
    expect(formatDocumentTitle({ projectName: 'funny', branch: 'master' })).toBe(
      'funny [master] — funny',
    );
  });

  test('project without branch', () => {
    expect(formatDocumentTitle({ projectName: 'funny' })).toBe('funny — funny');
  });

  test('scratch thread with title', () => {
    expect(
      formatDocumentTitle({
        isScratchThread: true,
        scratchTitle: 'regex test',
      }),
    ).toBe('regex test — funny');
  });

  test('fallback to app name', () => {
    expect(formatDocumentTitle({})).toBe('funny');
  });
});

describe('branchForDocumentTitle', () => {
  test('local thread prefers branch over baseBranch', () => {
    expect(branchForDocumentTitle({ mode: 'local', branch: 'feat/x', baseBranch: 'master' })).toBe(
      'feat/x',
    );
  });

  test('local thread falls back to baseBranch', () => {
    expect(branchForDocumentTitle({ mode: 'local', branch: null, baseBranch: 'master' })).toBe(
      'master',
    );
  });

  test('worktree thread derives branch from path when missing', () => {
    expect(
      branchForDocumentTitle({
        mode: 'worktree',
        branch: null,
        worktreePath: '/tmp/wt/funny-feat-abc123',
      }),
    ).toBe('funny/feat-abc123');
  });

  test('scratch thread has no branch label', () => {
    expect(
      branchForDocumentTitle({
        isScratch: true,
        mode: 'local',
        branch: 'stale',
        baseBranch: 'master',
      }),
    ).toBeUndefined();
  });
});

describe('document title stability on thread switch', () => {
  test('thread branch metadata wins over stale cwd branch during switch', () => {
    const nextTitle = formatDocumentTitle({
      projectName: 'funny',
      branch: branchForDocumentTitle({
        mode: 'local',
        branch: 'feat/new',
        baseBranch: 'master',
      }),
    });
    const staleCwdTitle = formatDocumentTitle({
      projectName: 'funny',
      branch: 'master',
    });

    expect(nextTitle).toBe('funny [feat/new] — funny');
    expect(nextTitle).not.toBe(staleCwdTitle);
  });
});
