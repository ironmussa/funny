import { describe, test, expect } from 'bun:test';
import { resolve } from 'path';
import { mkdirSync, rmSync } from 'fs';
import {
  validatePath,
  validatePathSync,
  pathExists,
  sanitizePath,
} from '../../utils/path-validation.js';

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
      expect(result).toBe(resolve(TEST_DIR));
    } finally {
      cleanup();
    }
  });

  test('throws for relative path', async () => {
    expect(validatePath('relative/path')).rejects.toThrow('Path must be absolute');
  });

  test('throws for non-existent path', async () => {
    expect(validatePath('/this/path/does/not/exist/xyz123')).rejects.toThrow(
      'Path does not exist'
    );
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
      'Path does not exist'
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
  // Use an absolute path appropriate for the current platform
  const base = process.platform === 'win32' ? 'C:\\Users\\test\\project' : '/home/user/project';

  test('resolves safe path within base', () => {
    const result = sanitizePath(base, 'src/file.ts');
    expect(result).toBe(resolve(base, 'src/file.ts'));
  });

  test('throws on path traversal with ../', () => {
    expect(() => sanitizePath(base, '../../../etc/passwd')).toThrow(
      'Path traversal detected'
    );
  });

  test('allows paths that resolve within base', () => {
    const result = sanitizePath(base, 'src/../src/file.ts');
    expect(result).toBe(resolve(base, 'src/file.ts'));
  });
});
