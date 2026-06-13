import { mkdirSync, rmSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { resolve, join } from 'path';

import {
  validatePath,
  validatePathSync,
  pathExists,
  sanitizePath,
  validateProjectPathLexical,
  validateProjectRootContainment,
  validateProjectRootPath,
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

// ── Project-root validation (security HI-3, shared by server + runner) ──
describe('validateProjectPathLexical', () => {
  test('rejects empty / non-string', () => {
    expect(validateProjectPathLexical('').isErr()).toBe(true);
    // @ts-expect-error — exercising the runtime guard for non-string input
    expect(validateProjectPathLexical(undefined).isErr()).toBe(true);
  });

  test('rejects relative paths', () => {
    const r = validateProjectPathLexical('relative/proj');
    expect(r.isErr()).toBe(true);
    if (r.isErr()) expect(r.error.message).toContain('absolute');
  });

  test('rejects leading-dash (flag injection)', () => {
    expect(validateProjectPathLexical('-rf').isErr()).toBe(true);
  });

  test('rejects null byte', () => {
    expect(validateProjectPathLexical('/home/u/p\0oj').isErr()).toBe(true);
  });

  test('rejects ".." segments', () => {
    const r = validateProjectPathLexical('/home/u/../etc');
    expect(r.isErr()).toBe(true);
    if (r.isErr()) expect(r.error.message).toContain('..');
  });

  test('rejects restricted system directories', () => {
    for (const p of ['/etc', '/etc/passwd', '/var/lib/x', '/usr/bin']) {
      const r = validateProjectPathLexical(p);
      expect(r.isErr()).toBe(true);
      if (r.isErr()) expect(r.error.message).toMatch(/restricted system directory/i);
    }
  });

  test('accepts a normal absolute path lexically', () => {
    expect(validateProjectPathLexical('/home/someone/code/proj').isOk()).toBe(true);
  });
});

describe('validateProjectRootContainment / validateProjectRootPath', () => {
  const prevRoot = process.env.FUNNY_PROJECT_ROOT;
  beforeEach(() => {
    delete process.env.FUNNY_PROJECT_ROOT;
  });
  afterEach(() => {
    if (prevRoot !== undefined) process.env.FUNNY_PROJECT_ROOT = prevRoot;
    else delete process.env.FUNNY_PROJECT_ROOT;
  });

  test('accepts a path under the current $HOME', () => {
    const p = join(homedir(), 'funny-core-test-proj');
    expect(validateProjectRootContainment(p).isOk()).toBe(true);
    expect(validateProjectRootPath(p).isOk()).toBe(true);
  });

  test('rejects a path outside $HOME without FUNNY_PROJECT_ROOT', () => {
    const r = validateProjectRootContainment('/opt/some-project');
    expect(r.isErr()).toBe(true);
    if (r.isErr()) expect(r.error.message).toMatch(/must live under \$HOME/i);
  });

  test('accepts an out-of-$HOME path when opted in via FUNNY_PROJECT_ROOT', () => {
    process.env.FUNNY_PROJECT_ROOT = '/opt';
    expect(validateProjectRootContainment('/opt/some-project').isOk()).toBe(true);
  });

  test('validateProjectRootPath chains lexical + containment', () => {
    // lexical failure short-circuits before the containment check
    expect(validateProjectRootPath('/etc').isErr()).toBe(true);
    expect(validateProjectRootPath('../rel').isErr()).toBe(true);
  });
});
