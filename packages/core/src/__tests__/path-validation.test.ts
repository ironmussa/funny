import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { resolve, join } from 'path';

import {
  validatePath,
  validatePathSync,
  pathExists,
  sanitizePath,
  resolveRepoRelativePath,
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

  // M9: `startsWith(base)` without a separator accepted sibling directories.
  test('rejects a sibling directory that shares the base name as a prefix', () => {
    expect(sanitizePath('/a/proj', '../proj-secrets/key').isErr()).toBe(true);
    expect(sanitizePath('/a/proj', '/a/proj-secrets/key').isErr()).toBe(true);
    expect(sanitizePath('/a/proj', '/a/proj/key').isOk()).toBe(true);
  });

  describe('symlinks', () => {
    const root = resolve(tmpdir(), 'core-sanitize-symlink');
    const base = join(root, 'proj');
    const outside = join(root, 'outside');

    beforeAll(() => {
      rmSync(root, { recursive: true, force: true });
      mkdirSync(base, { recursive: true });
      mkdirSync(outside, { recursive: true });
      writeFileSync(join(outside, 'secret.txt'), 'secret');
      symlinkSync(outside, join(base, 'escape-dir'));
      symlinkSync(join(outside, 'secret.txt'), join(base, 'escape-file'));
    });
    afterAll(() => rmSync(root, { recursive: true, force: true }));

    test('rejects a path whose parent directory is a symlink out of the base', () => {
      expect(sanitizePath(base, 'escape-dir/secret.txt').isErr()).toBe(true);
      expect(sanitizePath(base, 'escape-dir/not-yet-created.txt').isErr()).toBe(true);
    });

    test('rejects a final symlink out of the base when following it', () => {
      expect(sanitizePath(base, 'escape-file', { followFinalSymlink: true }).isErr()).toBe(true);
      // Git operations act on the link itself, so the default does not follow it.
      expect(sanitizePath(base, 'escape-file').isOk()).toBe(true);
    });

    test('resolveRepoRelativePath rejects both symlink escapes', () => {
      expect(resolveRepoRelativePath(base, 'escape-file').isErr()).toBe(true);
      expect(resolveRepoRelativePath(base, 'escape-dir/secret.txt').isErr()).toBe(true);
    });
  });
});

// H5: file paths taken from `?path=` on the diff routes.
describe('resolveRepoRelativePath', () => {
  test('rejects absolute paths outside the cwd', () => {
    expect(resolveRepoRelativePath(BASE_DIR, '/etc/passwd').isErr()).toBe(true);
    expect(resolveRepoRelativePath(BASE_DIR, `${BASE_DIR}-secrets/x`).isErr()).toBe(true);
  });

  test('rejects ".." segments even when they stay inside the cwd', () => {
    expect(resolveRepoRelativePath(BASE_DIR, '../../x').isErr()).toBe(true);
    expect(resolveRepoRelativePath(BASE_DIR, 'a/../b').isErr()).toBe(true);
  });

  test('rejects empty paths and NUL bytes', () => {
    expect(resolveRepoRelativePath(BASE_DIR, '').isErr()).toBe(true);
    expect(resolveRepoRelativePath(BASE_DIR, 'a\0b').isErr()).toBe(true);
  });

  test('returns relative paths unchanged and relativizes absolute ones inside the cwd', () => {
    expect(resolveRepoRelativePath(BASE_DIR, 'src/a.ts').unwrapOr(null)).toBe('src/a.ts');
    expect(resolveRepoRelativePath(BASE_DIR, join(BASE_DIR, 'src', 'a.ts')).unwrapOr(null)).toBe(
      join('src', 'a.ts'),
    );
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

  test('allows root-home repositories through host-independent lexical validation', () => {
    expect(validateProjectPathLexical('/root/my-repo').isOk()).toBe(true);
    for (const path of ['/root', '/root/.ssh', '/root/.aws/credentials']) {
      expect(validateProjectPathLexical(path).isErr()).toBe(true);
    }
  });

  test('accepts a normal absolute path lexically', () => {
    expect(validateProjectPathLexical('/home/someone/code/proj').isOk()).toBe(true);
  });
});

describe('validateProjectRootContainment / validateProjectRootPath', () => {
  const prevRoot = process.env.FUNNY_PROJECT_ROOT;
  const prevPolicy = process.env.FUNNY_PROJECT_PATH_POLICY;
  beforeEach(() => {
    delete process.env.FUNNY_PROJECT_ROOT;
    process.env.FUNNY_PROJECT_PATH_POLICY = 'restricted';
  });
  afterEach(() => {
    if (prevPolicy === undefined) delete process.env.FUNNY_PROJECT_PATH_POLICY;
    else process.env.FUNNY_PROJECT_PATH_POLICY = prevPolicy;
    if (prevRoot !== undefined) process.env.FUNNY_PROJECT_ROOT = prevRoot;
    else delete process.env.FUNNY_PROJECT_ROOT;
  });

  test('allows root-home repositories only when root is the filesystem owner home', () => {
    const previousHome = process.env.HOME;
    try {
      process.env.HOME = '/root';
      expect(validateProjectRootPath('/root/my-repo').isOk()).toBe(true);
      expect(validateProjectRootPath('/root/.ssh/repo').isErr()).toBe(true);
      expect(validateProjectRootPath('/root').isErr()).toBe(true);
      process.env.HOME = '/home/another-user';
      process.env.FUNNY_PROJECT_ROOT = '/root';
      expect(validateProjectRootPath('/root/my-repo').isErr()).toBe(true);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
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
