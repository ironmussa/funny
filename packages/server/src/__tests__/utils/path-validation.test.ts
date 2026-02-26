import { describe, test, expect } from 'bun:test';
import { mkdirSync, rmSync } from 'fs';
import { resolve, join } from 'path';

import { validatePath, validatePathSync, pathExists, sanitizePath } from '@funny/core/git';

const TEST_DIR = resolve(import.meta.dir, '..', '..', '..', '.test-tmp-path-validation');

// Setup / teardown
function setup() {
  mkdirSync(TEST_DIR, { recursive: true });
}

function cleanup() {
  try {
    rmSync(TEST_DIR, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

describe('validatePath (async)', () => {
  test('returns resolved path for existing absolute path', async () => {
    setup();
    try {
      const result = await validatePath(TEST_DIR);
      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value).toBe(resolve(TEST_DIR));
      }
    } finally {
      cleanup();
    }
  });

  test('returns error for relative path', async () => {
    const result = await validatePath('relative/path');
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe('BAD_REQUEST');
      expect(result.error.message).toContain('absolute');
    }
  });

  test('returns error for non-existent path', async () => {
    const result = await validatePath('/this/path/does/not/exist/xyz123');
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe('BAD_REQUEST');
      expect(result.error.message).toContain('not accessible');
    }
  });
});

describe('validatePathSync', () => {
  test('returns resolved path for existing absolute path', () => {
    setup();
    try {
      const result = validatePathSync(TEST_DIR);
      expect(result).toBe(resolve(TEST_DIR));
    } finally {
      cleanup();
    }
  });

  test('throws for relative path', () => {
    expect(() => validatePathSync('relative/path')).toThrow('Path must be absolute');
  });

  test('throws for non-existent path', () => {
    expect(() => validatePathSync('/this/path/does/not/exist/xyz123')).toThrow(
      'Path does not exist',
    );
  });
});

describe('pathExists', () => {
  test('returns true for existing path', async () => {
    setup();
    try {
      expect(await pathExists(TEST_DIR)).toBe(true);
    } finally {
      cleanup();
    }
  });

  test('returns false for non-existent path', async () => {
    expect(await pathExists('/this/does/not/exist/abc789')).toBe(false);
  });
});

describe('sanitizePath', () => {
  // Use a resolved absolute path for the current platform
  const base = resolve(
    process.platform === 'win32' ? 'C:\\Users\\test\\project' : '/home/user/project',
  );

  test('resolves safe path within base', () => {
    const result = sanitizePath(base, 'src/file.ts');
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toBe(join(base, 'src', 'file.ts'));
    }
  });

  test('rejects path traversal with ../', () => {
    const result = sanitizePath(base, '../../../etc/passwd');
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe('FORBIDDEN');
      expect(result.error.message).toContain('traversal');
    }
  });

  test('allows paths that resolve within base', () => {
    const result = sanitizePath(base, 'src/../src/file.ts');
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toBe(join(base, 'src', 'file.ts'));
    }
  });
});
