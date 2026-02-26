import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { augmentPromptWithFiles } from '../../utils/file-mentions.js';

describe('augmentPromptWithFiles', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(
      tmpdir(),
      `file-mentions-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  // ── No-op cases ────────────────────────────────────────────

  test('returns prompt unchanged when fileReferences is undefined', async () => {
    const result = await augmentPromptWithFiles('hello world', undefined, testDir);
    expect(result).toBe('hello world');
  });

  test('returns prompt unchanged when fileReferences is empty array', async () => {
    const result = await augmentPromptWithFiles('hello world', [], testDir);
    expect(result).toBe('hello world');
  });

  // ── Successful file inlining ───────────────────────────────

  test('inlines file content wrapped in <file> tags', async () => {
    writeFileSync(join(testDir, 'test.txt'), 'file content here');

    const result = await augmentPromptWithFiles('my prompt', [{ path: 'test.txt' }], testDir);

    expect(result).toContain('<referenced-files>');
    expect(result).toContain('</referenced-files>');
    expect(result).toContain('<file path="test.txt">');
    expect(result).toContain('file content here');
    expect(result).toContain('</file>');
  });

  test('adds <referenced-files> wrapper around all files', async () => {
    writeFileSync(join(testDir, 'a.txt'), 'content a');
    writeFileSync(join(testDir, 'b.txt'), 'content b');

    const result = await augmentPromptWithFiles(
      'prompt',
      [{ path: 'a.txt' }, { path: 'b.txt' }],
      testDir,
    );

    expect(result).toContain('<referenced-files>');
    expect(result).toContain('<file path="a.txt">');
    expect(result).toContain('content a');
    expect(result).toContain('<file path="b.txt">');
    expect(result).toContain('content b');
    expect(result).toContain('</referenced-files>');
  });

  test('prepends file context before the prompt', async () => {
    writeFileSync(join(testDir, 'test.txt'), 'data');

    const result = await augmentPromptWithFiles('my prompt', [{ path: 'test.txt' }], testDir);

    // File context should come before the prompt
    const fileContextEnd = result.indexOf('</referenced-files>');
    const promptStart = result.indexOf('my prompt');
    expect(fileContextEnd).toBeLessThan(promptStart);
  });

  test('handles files in subdirectories', async () => {
    mkdirSync(join(testDir, 'src', 'utils'), { recursive: true });
    writeFileSync(join(testDir, 'src', 'utils', 'helper.ts'), 'export const x = 1;');

    const result = await augmentPromptWithFiles(
      'prompt',
      [{ path: 'src/utils/helper.ts' }],
      testDir,
    );

    expect(result).toContain('<file path="src/utils/helper.ts">');
    expect(result).toContain('export const x = 1;');
  });

  // ── Path traversal blocking ────────────────────────────────

  test('blocks path traversal with ../', async () => {
    // Create a file outside the base path
    const outsideDir = join(tmpdir(), `outside-${Date.now()}`);
    mkdirSync(outsideDir, { recursive: true });
    writeFileSync(join(outsideDir, 'secret.txt'), 'sensitive data');

    try {
      const result = await augmentPromptWithFiles('prompt', [{ path: '../secret.txt' }], testDir);

      // The file should be silently skipped; prompt returned unchanged
      expect(result).toBe('prompt');
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  test('blocks deeply nested path traversal', async () => {
    const result = await augmentPromptWithFiles(
      'prompt',
      [{ path: 'src/../../etc/passwd' }],
      testDir,
    );

    // Should be silently skipped
    expect(result).toBe('prompt');
  });

  // ── File too large ─────────────────────────────────────────

  test('shows "too large" note for files > 100KB', async () => {
    // Create a file just over 100KB
    const bigContent = 'x'.repeat(101 * 1024);
    writeFileSync(join(testDir, 'big.txt'), bigContent);

    const result = await augmentPromptWithFiles('prompt', [{ path: 'big.txt' }], testDir);

    expect(result).toContain('<file path="big.txt"');
    expect(result).toContain('File too large to inline');
    expect(result).toContain('Use the Read tool');
    // Should NOT contain the actual file content
    expect(result).not.toContain('x'.repeat(100));
  });

  test('shows size in KB for large files', async () => {
    const size = 150 * 1024;
    writeFileSync(join(testDir, 'large.bin'), 'y'.repeat(size));

    const result = await augmentPromptWithFiles('prompt', [{ path: 'large.bin' }], testDir);

    expect(result).toContain('150KB');
  });

  // ── File not found ─────────────────────────────────────────

  test('shows "not found" note for missing files', async () => {
    const result = await augmentPromptWithFiles('prompt', [{ path: 'nonexistent.ts' }], testDir);

    expect(result).toContain('<file path="nonexistent.ts"');
    expect(result).toContain('File not found or unreadable');
  });

  // ── Total size limit (500KB) ───────────────────────────────

  test('respects 500KB total limit by marking subsequent files as too large', async () => {
    // Create several files that together exceed 500KB
    // File 1: 90KB (under per-file limit, total: 90KB)
    writeFileSync(join(testDir, 'file1.txt'), 'a'.repeat(90 * 1024));
    // File 2: 90KB (under per-file limit, total: 180KB)
    writeFileSync(join(testDir, 'file2.txt'), 'b'.repeat(90 * 1024));
    // File 3: 90KB (under per-file limit, total: 270KB)
    writeFileSync(join(testDir, 'file3.txt'), 'c'.repeat(90 * 1024));
    // File 4: 90KB (under per-file limit, total: 360KB)
    writeFileSync(join(testDir, 'file4.txt'), 'd'.repeat(90 * 1024));
    // File 5: 90KB (under per-file limit, total: 450KB)
    writeFileSync(join(testDir, 'file5.txt'), 'e'.repeat(90 * 1024));
    // File 6: 90KB (would exceed 500KB total)
    writeFileSync(join(testDir, 'file6.txt'), 'f'.repeat(90 * 1024));

    const result = await augmentPromptWithFiles(
      'prompt',
      [
        { path: 'file1.txt' },
        { path: 'file2.txt' },
        { path: 'file3.txt' },
        { path: 'file4.txt' },
        { path: 'file5.txt' },
        { path: 'file6.txt' },
      ],
      testDir,
    );

    // First five files should have their content inlined
    expect(result).toContain('a'.repeat(100));
    expect(result).toContain('b'.repeat(100));
    expect(result).toContain('c'.repeat(100));
    expect(result).toContain('d'.repeat(100));
    expect(result).toContain('e'.repeat(100));

    // The sixth file should be marked as too large because totalSize would exceed 500KB
    // It appears as a note rather than inlined content
    expect(result).toContain('file6.txt');
    expect(result).toContain('File too large to inline');
  });

  // ── Mixed scenarios ────────────────────────────────────────

  test('handles mix of existing, missing, and large files', async () => {
    writeFileSync(join(testDir, 'good.txt'), 'valid content');
    writeFileSync(join(testDir, 'huge.txt'), 'x'.repeat(101 * 1024));

    const result = await augmentPromptWithFiles(
      'prompt',
      [{ path: 'good.txt' }, { path: 'missing.txt' }, { path: 'huge.txt' }],
      testDir,
    );

    expect(result).toContain('<referenced-files>');
    // Inlined file
    expect(result).toContain('<file path="good.txt">');
    expect(result).toContain('valid content');
    // Missing file
    expect(result).toContain('<file path="missing.txt"');
    expect(result).toContain('File not found or unreadable');
    // Too large file
    expect(result).toContain('<file path="huge.txt"');
    expect(result).toContain('File too large to inline');
    // Prompt is still there
    expect(result).toContain('prompt');
  });

  test('preserves exact file content including newlines', async () => {
    const content = 'line1\nline2\nline3\n';
    writeFileSync(join(testDir, 'multi.txt'), content);

    const result = await augmentPromptWithFiles('prompt', [{ path: 'multi.txt' }], testDir);

    expect(result).toContain(content);
  });

  test('empty file is inlined (0 bytes)', async () => {
    writeFileSync(join(testDir, 'empty.txt'), '');

    const result = await augmentPromptWithFiles('prompt', [{ path: 'empty.txt' }], testDir);

    expect(result).toContain('<file path="empty.txt">');
    expect(result).toContain('</file>');
  });
});
