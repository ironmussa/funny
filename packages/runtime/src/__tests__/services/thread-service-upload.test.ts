import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireThreadCwd: vi.fn(),
}));

vi.mock('../../lib/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../utils/route-helpers.js', () => ({
  requireThreadCwd: mocks.requireThreadCwd,
}));

import { ok, err } from 'neverthrow';

import { uploadFile } from '../../services/thread-service/upload.js';

describe('uploadFile', () => {
  let cwd: string;

  beforeEach(() => {
    vi.clearAllMocks();
    cwd = mkdtempSync(join(tmpdir(), 'funny-upload-test-'));
    mocks.requireThreadCwd.mockResolvedValue(ok(cwd));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  test('returns error when thread cwd cannot be resolved', async () => {
    mocks.requireThreadCwd.mockResolvedValue(
      err({ type: 'NOT_FOUND', message: 'Thread not found' }),
    );

    const result = await uploadFile({
      threadId: 'missing',
      userId: 'u-1',
      provider: 'claude',
      filename: 'notes.txt',
      contentBase64: Buffer.from('hello').toString('base64'),
    });

    expect(result.isErr()).toBe(true);
  });

  test('returns internal error when disk write fails', async () => {
    mocks.requireThreadCwd.mockResolvedValue(ok('/proc/self/mem'));

    const result = await uploadFile({
      threadId: 't-1',
      userId: 'u-1',
      provider: 'claude',
      filename: 'notes.txt',
      contentBase64: Buffer.from('hello').toString('base64'),
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe('INTERNAL');
      expect(result.error.message).toContain('write');
    }
  });

  test('returns 400 for empty decoded content', async () => {
    const result = await uploadFile({
      threadId: 't-1',
      userId: 'u-1',
      provider: 'claude',
      filename: 'empty.txt',
      contentBase64: Buffer.from('').toString('base64'),
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe('BAD_REQUEST');
      expect(result.error.message).toContain('Empty');
    }
  });

  test('returns 400 when file exceeds provider upload limit', async () => {
    const huge = Buffer.alloc(26 * 1024 * 1024, 1);

    const result = await uploadFile({
      threadId: 't-1',
      userId: 'u-1',
      provider: 'claude',
      filename: 'huge.bin',
      contentBase64: huge.toString('base64'),
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe('BAD_REQUEST');
      expect(result.error.message).toContain('too large');
    }
  });

  test('writes file under .funny/uploads and returns relative path', async () => {
    const content = 'attachment payload';
    const result = await uploadFile({
      threadId: 't-1',
      userId: 'u-1',
      provider: 'claude',
      filename: 'my notes.txt',
      contentBase64: Buffer.from(content).toString('base64'),
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.path).toBe('.funny/uploads/t-1/my_notes.txt');
      expect(result.value.size).toBe(content.length);
    }

    const fullPath = join(cwd, '.funny', 'uploads', 't-1', 'my_notes.txt');
    expect(readFileSync(fullPath, 'utf8')).toBe(content);
    expect(existsSync(join(cwd, '.funny', '.gitignore'))).toBe(true);
  });

  test('sanitizes path traversal in browser filename', async () => {
    const result = await uploadFile({
      threadId: 't-1',
      userId: 'u-1',
      provider: 'claude',
      filename: '../../../etc/passwd',
      contentBase64: Buffer.from('safe').toString('base64'),
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.path).toBe('.funny/uploads/t-1/passwd');
    }
    expect(existsSync(join(cwd, 'etc', 'passwd'))).toBe(false);
    expect(existsSync(join(cwd, '.funny', 'uploads', 't-1', 'passwd'))).toBe(true);
  });
});
