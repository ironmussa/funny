import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
/**
 * Regression tests for the file-picker pipeline.
 *
 * Two things must keep working forever:
 *
 *   1. Heavy build/cache directories are pruned. Letting `Library/`,
 *      `node_modules/`, etc. through balloons the response and crashes the
 *      WS-tunnel ack (incident: CT-12-24, May 2026).
 *   2. The native (`gitoxide`) and CLI (`git ls-files`) backends must agree
 *      on the file set, including the heavy-dir filter — they're hot-swapped
 *      via `getNativeGit()` and we don't want behaviour to drift.
 */
import { execSync } from 'child_process';
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { getNativeGit } from '@funny/core/git';

import {
  HEAVY_IGNORED_DIRS,
  gitLsFiles,
  invalidateGitFilesCache,
  resolveGitFiles,
} from '../../utils/git-files.js';

function initRepo(dir: string) {
  execSync('git init -q', { cwd: dir });
  execSync('git config user.email test@example.com', { cwd: dir });
  execSync('git config user.name test', { cwd: dir });
}

function commitAll(dir: string) {
  execSync('git add -A && git commit -q -m "init" --allow-empty', { cwd: dir });
}

describe('git-files: heavy-dir filtering', () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'git-files-test-'));
    initRepo(repo);
    invalidateGitFilesCache();
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  test('HEAVY_IGNORED_DIRS includes the directories that broke us', () => {
    // Lock in coverage for cache dirs we've actually been bitten by. Adding
    // here is fine; deleting any of these means a regression.
    for (const must of [
      'node_modules',
      '.git',
      'dist',
      'build',
      'Library', // Unity — CT-12-24 incident
      'target', // Rust
      'obj', // .NET
      '__pycache__', // Python
      'vendor',
    ]) {
      expect(HEAVY_IGNORED_DIRS.has(must)).toBe(true);
    }
  });

  test('CLI fallback skips heavy directories at any depth', async () => {
    // tracked file we want to keep
    writeFileSync(join(repo, 'src.ts'), 'export {};');
    // ignored .env at root — should be surfaced
    writeFileSync(join(repo, '.gitignore'), 'node_modules\nLibrary\n.env\n');
    writeFileSync(join(repo, '.env'), 'SECRET=1');
    // heavy dir contents — must be hidden
    mkdirSync(join(repo, 'node_modules', 'foo'), { recursive: true });
    writeFileSync(join(repo, 'node_modules', 'foo', 'index.js'), 'noop');
    mkdirSync(join(repo, 'Library', 'PackageCache'), { recursive: true });
    writeFileSync(join(repo, 'Library', 'PackageCache', 'a.bin'), 'noop');
    // nested heavy dir
    mkdirSync(join(repo, 'packages', 'foo', 'dist'), { recursive: true });
    writeFileSync(join(repo, 'packages', 'foo', 'dist', 'bundle.js'), 'noop');
    writeFileSync(join(repo, 'packages', 'foo', 'src.ts'), 'export {};');
    commitAll(repo);

    const files = await gitLsFiles(repo);

    expect(files).toContain('src.ts');
    expect(files).toContain('.env');
    expect(files).toContain('packages/foo/src.ts');
    expect(files.find((f) => f.startsWith('node_modules/'))).toBeUndefined();
    expect(files.find((f) => f.startsWith('Library/'))).toBeUndefined();
    expect(files.find((f) => f.startsWith('packages/foo/dist/'))).toBeUndefined();
  });

  test('native and CLI backends return the same file set', async () => {
    const native = getNativeGit();
    if (!native?.listFiles) {
      // Native binary not built for this platform — skip rather than fail CI.
      return;
    }

    writeFileSync(join(repo, 'a.ts'), '');
    writeFileSync(join(repo, '.gitignore'), 'node_modules\nLibrary\n.env\n');
    writeFileSync(join(repo, '.env'), 'X=1');
    mkdirSync(join(repo, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(repo, 'node_modules', 'pkg', 'idx.js'), '');
    mkdirSync(join(repo, 'Library', 'cache'), { recursive: true });
    writeFileSync(join(repo, 'Library', 'cache', 'x.bin'), '');
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'b.ts'), '');
    commitAll(repo);

    const cliSet = new Set(await gitLsFiles(repo));
    const nativeSet = new Set(await native.listFiles(repo, { includeIgnored: true }));

    // Same file set (heavy-dir filter applied identically on both sides).
    expect([...nativeSet].sort()).toEqual([...cliSet].sort());
  });

  test('resolveGitFiles caches and dedupes', async () => {
    writeFileSync(join(repo, 'one.ts'), '');
    writeFileSync(join(repo, 'two.ts'), '');
    commitAll(repo);

    const a = await resolveGitFiles(repo);
    const b = await resolveGitFiles(repo);
    // Cache returns the SAME array reference on hit, not a copy.
    expect(b).toBe(a);
    expect(a).toContain('one.ts');
    expect(a).toContain('two.ts');
  });
});
