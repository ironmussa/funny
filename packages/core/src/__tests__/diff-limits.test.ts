import { describe, test, expect, vi, beforeEach } from 'bun:test';

import { mocked } from '@funny/test-kit';

vi.mock('../git/process.js', () => ({
  gitRead: vi.fn(),
}));
vi.mock('../git/native.js', () => ({
  getNativeGit: () => null,
}));

import { getDiff } from '../git/diff.js';
import { gitRead } from '../git/process.js';

const mockedGitRead = mocked(gitRead);

/** Helper to build a fake git command result */
function gitResult(stdout: string, exitCode = 0) {
  return { stdout, stderr: '', exitCode };
}

/** Build a unified diff header for a file */
function makeDiffChunk(filePath: string, content: string): string {
  return `diff --git a/${filePath} b/${filePath}\nindex 0000000..1111111 100644\n--- a/${filePath}\n+++ b/${filePath}\n@@ -0,0 +1 @@\n${content}`;
}

/**
 * Configure gitRead mock for getDiff's 5 parallel calls:
 *   0: diff --staged --name-status
 *   1: diff --name-status
 *   2: ls-files --others --exclude-standard
 *   3: diff --staged (full diff)
 *   4: diff (full diff, unstaged)
 */
function setupMock(opts: {
  stagedStatus?: string;
  unstagedStatus?: string;
  untracked?: string;
  stagedDiff?: string;
  unstagedDiff?: string;
}) {
  let callIndex = 0;
  mockedGitRead.mockImplementation(async () => {
    const idx = callIndex++;
    switch (idx) {
      case 0:
        return gitResult(opts.stagedStatus ?? '');
      case 1:
        return gitResult(opts.unstagedStatus ?? '');
      case 2:
        return gitResult(opts.untracked ?? '');
      case 3:
        return gitResult(opts.stagedDiff ?? '');
      case 4:
        return gitResult(opts.unstagedDiff ?? '');
      default:
        return gitResult('');
    }
  });
}

describe('getDiff size limits', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('normal diffs under limits are returned as-is', async () => {
    const diffContent = makeDiffChunk('src/app.ts', '+console.log("hello");');

    setupMock({
      stagedStatus: '',
      unstagedStatus: 'M\tsrc/app.ts',
      untracked: '',
      stagedDiff: '',
      unstagedDiff: diffContent,
    });

    const result = await getDiff('/fake/repo');
    expect(result.isOk()).toBe(true);

    const diffs = result._unsafeUnwrap();
    expect(diffs).toHaveLength(1);
    expect(diffs[0].path).toBe('src/app.ts');
    expect(diffs[0].staged).toBe(false);
    expect(diffs[0].status).toBe('modified');
    expect(diffs[0].diff).toBe(diffContent);
    expect(diffs[0].diff).not.toContain('[diff truncated');
  });

  test('single file diff exceeding 512KB gets truncated', async () => {
    // Create a diff larger than 512KB
    const largeLine = '+' + 'x'.repeat(1024) + '\n';
    const lineCount = 600; // ~600KB
    const largeContent = largeLine.repeat(lineCount);
    const largeDiff = makeDiffChunk('big-file.ts', largeContent);

    setupMock({
      stagedStatus: 'M\tbig-file.ts',
      unstagedStatus: '',
      untracked: '',
      stagedDiff: largeDiff,
      unstagedDiff: '',
    });

    const result = await getDiff('/fake/repo');
    expect(result.isOk()).toBe(true);

    const diffs = result._unsafeUnwrap();
    expect(diffs).toHaveLength(1);
    expect(diffs[0].path).toBe('big-file.ts');
    expect(diffs[0].staged).toBe(true);
    expect(diffs[0].diff).toContain('... [diff truncated — file too large] ...');
    // The truncated diff should be smaller than the original
    expect(Buffer.byteLength(diffs[0].diff, 'utf8')).toBeLessThan(
      Buffer.byteLength(largeDiff, 'utf8'),
    );
  });

  test('total payload exceeding 10MB causes remaining files to be omitted', async () => {
    // Create files that collectively exceed 10MB
    // Each file is ~600KB (under the 512KB per-file limit after truncation)
    // We need roughly 20 files of ~500KB each to exceed 10MB
    const fileCount = 22;
    const lineContent = '+' + 'y'.repeat(500) + '\n';
    const linesPerFile = 1000; // ~500KB per file
    const perFileContent = lineContent.repeat(linesPerFile);

    const stagedStatusLines: string[] = [];
    const diffChunks: string[] = [];

    for (let i = 0; i < fileCount; i++) {
      const fileName = `file-${i.toString().padStart(3, '0')}.ts`;
      stagedStatusLines.push(`M\t${fileName}`);
      diffChunks.push(makeDiffChunk(fileName, perFileContent));
    }

    setupMock({
      stagedStatus: stagedStatusLines.join('\n'),
      unstagedStatus: '',
      untracked: '',
      stagedDiff: diffChunks.join('\n'),
      unstagedDiff: '',
    });

    const result = await getDiff('/fake/repo');
    expect(result.isOk()).toBe(true);

    const diffs = result._unsafeUnwrap();
    expect(diffs).toHaveLength(fileCount);

    // Some early files should have actual diff content
    const filesWithContent = diffs.filter((d) => !d.diff.includes('[diff omitted'));
    const filesOmitted = diffs.filter((d) =>
      d.diff.includes('... [diff omitted — total payload size limit reached] ...'),
    );

    expect(filesWithContent.length).toBeGreaterThan(0);
    expect(filesOmitted.length).toBeGreaterThan(0);

    // Omitted files should appear after content files (order is preserved)
    const firstOmittedIndex = diffs.findIndex((d) => d.diff.includes('[diff omitted'));
    const lastContentIndex =
      diffs.length - 1 - [...diffs].reverse().findIndex((d) => !d.diff.includes('[diff omitted'));
    expect(firstOmittedIndex).toBeGreaterThan(0);
    expect(lastContentIndex).toBeLessThan(firstOmittedIndex);
  });

  test('empty diffs work correctly', async () => {
    setupMock({
      stagedStatus: '',
      unstagedStatus: '',
      untracked: '',
      stagedDiff: '',
      unstagedDiff: '',
    });

    const result = await getDiff('/fake/repo');
    expect(result.isOk()).toBe(true);

    const diffs = result._unsafeUnwrap();
    expect(diffs).toHaveLength(0);
  });

  test('mix of staged and unstaged files works', async () => {
    const stagedDiff = makeDiffChunk('staged-file.ts', '+staged content');
    const unstagedDiff = makeDiffChunk('unstaged-file.ts', '+unstaged content');

    setupMock({
      stagedStatus: 'M\tstaged-file.ts',
      unstagedStatus: 'M\tunstaged-file.ts',
      untracked: 'new-file.ts',
      stagedDiff,
      unstagedDiff,
    });

    const result = await getDiff('/fake/repo');
    expect(result.isOk()).toBe(true);

    const diffs = result._unsafeUnwrap();
    expect(diffs).toHaveLength(3);

    const staged = diffs.find((d) => d.path === 'staged-file.ts');
    expect(staged).toBeDefined();
    expect(staged!.staged).toBe(true);
    expect(staged!.status).toBe('modified');
    expect(staged!.diff).toBe(stagedDiff);

    const unstaged = diffs.find((d) => d.path === 'unstaged-file.ts');
    expect(unstaged).toBeDefined();
    expect(unstaged!.staged).toBe(false);
    expect(unstaged!.status).toBe('modified');
    expect(unstaged!.diff).toBe(unstagedDiff);

    const untracked = diffs.find((d) => d.path === 'new-file.ts');
    expect(untracked).toBeDefined();
    expect(untracked!.staged).toBe(false);
    expect(untracked!.status).toBe('added');
    // Untracked files have no diff in the unstaged diff blob
    expect(untracked!.diff).toBe('');
  });

  test('staged file that also appears in unstaged is not duplicated', async () => {
    const stagedDiff = makeDiffChunk('shared.ts', '+staged version');
    const unstagedDiff = makeDiffChunk('shared.ts', '+unstaged version');

    setupMock({
      stagedStatus: 'M\tshared.ts',
      unstagedStatus: 'M\tshared.ts',
      untracked: '',
      stagedDiff,
      unstagedDiff,
    });

    const result = await getDiff('/fake/repo');
    expect(result.isOk()).toBe(true);

    const diffs = result._unsafeUnwrap();
    // Should only appear once (the staged version), since getDiff skips
    // unstaged files that are already in the staged set
    expect(diffs).toHaveLength(1);
    expect(diffs[0].path).toBe('shared.ts');
    expect(diffs[0].staged).toBe(true);
  });
});
