import { mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { resolve, join } from 'path';

import { describe, test, expect } from 'vitest';

import {
  validatePath,
  validatePathSync,
  pathExists,
  sanitizePath,
} from '../git/path-validation.js';

const TMP = resolve(tmpdir(), 'core-path-validation-test');
/** A real, resolved base directory suitable for sanitizePath tests on all OSes */
const BASE_DIR = resolve(tmpdir(), 'core-sanitize-base');

describe('validatePath (async)', () => {
  test('rejects relative paths', async () => {
    const result = await validatePath('relative/path');
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe('BAD_REQUEST');
      expect(result.error.message).toContain('absolute');
    }
  });

  test('rejects non-existent paths', async () => {
    const result = await validatePath('/nonexistent/path/xyz-12345');
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe('BAD_REQUEST');
      expect(result.error.message).toContain('not accessible');
    }
  });

  test('accepts existing absolute paths', async () => {
    mkdirSync(TMP, { recursive: true });
    try {
      const result = await validatePath(TMP);
      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value).toBe(resolve(TMP));
      }
    } finally {
      rmSync(TMP, { recursive: true, force: true });
    }
  });
});

describe('validatePathSync', () => {
  test('throws for relative paths', () => {
    expect(() => validatePathSync('relative/path')).toThrow('absolute');
  });

  test('throws for non-existent paths', () => {
    expect(() => validatePathSync('/nonexistent/path/xyz-12345')).toThrow('not accessible');
  });

  test('returns resolved path for existing absolute paths', () => {
    mkdirSync(TMP, { recursive: true });
    try {
      const result = validatePathSync(TMP);
      expect(result).toBe(resolve(TMP));
    } finally {
      rmSync(TMP, { recursive: true, force: true });
    }
  });
});

describe('pathExists', () => {
  test('returns true for existing path', async () => {
    mkdirSync(TMP, { recursive: true });
    try {
      expect(await pathExists(TMP)).toBe(true);
    } finally {
      rmSync(TMP, { recursive: true, force: true });
    }
  });

  test('returns false for non-existent path', async () => {
    expect(await pathExists('/nonexistent/path/xyz-12345')).toBe(false);
  });
});

describe('sanitizePath', () => {
  test('allows path within base directory', () => {
    const result = sanitizePath(BASE_DIR, 'sub/file.txt');
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toBe(join(BASE_DIR, 'sub', 'file.txt'));
    }
  });

  test('rejects path traversal with ../', () => {
    const result = sanitizePath(BASE_DIR, '../../etc/passwd');
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe('FORBIDDEN');
      expect(result.error.message).toContain('traversal');
    }
  });

  test('allows nested subdirectories', () => {
    const result = sanitizePath(BASE_DIR, 'a/b/c/d.txt');
    expect(result.isOk()).toBe(true);
  });

  test('rejects absolute paths that escape base', () => {
    const result = sanitizePath(BASE_DIR, '../outside');
    expect(result.isErr()).toBe(true);
  });
});
