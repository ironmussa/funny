/**
 * Extension discovery, management, and safe asset resolution. Pins the contract
 * the client loader and the `/extensions/*` route depend on: a valid package is
 * surfaced with a same-origin entryUrl, malformed packages are skipped, install/
 * remove round-trip, and path traversal / symlink escape are refused.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  discoverExtensions,
  extensionAssetContentType,
  installExtensionFromPath,
  listInstalledExtensions,
  removeExtension,
  resolveExtensionAsset,
} from '../../lib/extensions.js';

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'funny-ext-'));

  // Valid extension.
  const ok = join(dir, 'funny-visualizer-csv');
  mkdirSync(join(ok, 'dist'), { recursive: true });
  writeFileSync(
    join(ok, 'package.json'),
    JSON.stringify({
      name: 'funny-visualizer-csv',
      version: '0.1.0',
      funny: { client: 'dist/index.mjs' },
    }),
  );
  writeFileSync(join(ok, 'dist', 'index.mjs'), 'export default {};');

  // Missing funny.client → skipped.
  const noEntry = join(dir, 'no-entry');
  mkdirSync(noEntry, { recursive: true });
  writeFileSync(
    join(noEntry, 'package.json'),
    JSON.stringify({ name: 'no-entry', version: '1.0.0' }),
  );

  // Malformed package.json → skipped.
  const broken = join(dir, 'broken');
  mkdirSync(broken, { recursive: true });
  writeFileSync(join(broken, 'package.json'), '{ not json');
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('discoverExtensions', () => {
  test('surfaces only the valid extension, with a same-origin entryUrl', () => {
    const found = discoverExtensions(dir);
    expect(found).toHaveLength(1);
    expect(found[0]).toEqual({
      id: 'funny-visualizer-csv',
      version: '0.1.0',
      entryUrl: '/extensions/funny-visualizer-csv/dist/index.mjs',
    });
  });

  test('returns [] for a non-existent directory', () => {
    expect(discoverExtensions(join(dir, 'does-not-exist'))).toEqual([]);
  });
});

describe('resolveExtensionAsset', () => {
  test('resolves a real asset inside the extension', () => {
    expect(resolveExtensionAsset('funny-visualizer-csv', 'dist/index.mjs', dir)).toBe(
      realpathSync(join(dir, 'funny-visualizer-csv', 'dist', 'index.mjs')),
    );
  });

  test('refuses path traversal and unsafe names', () => {
    expect(resolveExtensionAsset('funny-visualizer-csv', '../../etc/passwd', dir)).toBeNull();
    expect(resolveExtensionAsset('..', 'package.json', dir)).toBeNull();
    expect(resolveExtensionAsset('a/b', 'index.mjs', dir)).toBeNull();
  });

  test('returns null for a missing file', () => {
    expect(resolveExtensionAsset('funny-visualizer-csv', 'dist/nope.mjs', dir)).toBeNull();
  });
});

// Regression: a symlink inside an installed package must not let a request
// escape the extension dir, and such a package must not even be surfaced.
describe('symlink escape', () => {
  let sdir: string;
  let secretsDir: string;

  beforeAll(() => {
    sdir = realpathSync(mkdtempSync(join(tmpdir(), 'funny-ext-sym-')));
    secretsDir = realpathSync(mkdtempSync(join(tmpdir(), 'funny-secret-')));
    writeFileSync(join(secretsDir, 'secret.txt'), 'top secret');

    const ext = join(sdir, 'sneaky');
    mkdirSync(join(ext, 'dist'), { recursive: true });
    writeFileSync(
      join(ext, 'package.json'),
      JSON.stringify({ name: 'sneaky', version: '1.0.0', funny: { client: 'dist/leak.mjs' } }),
    );
    symlinkSync(join(secretsDir, 'secret.txt'), join(ext, 'dist', 'leak.mjs'));
    symlinkSync(secretsDir, join(ext, 'escape'));
  });

  afterAll(() => {
    rmSync(sdir, { recursive: true, force: true });
    rmSync(secretsDir, { recursive: true, force: true });
  });

  test('refuses a symlinked asset pointing outside the extension dir', () => {
    expect(resolveExtensionAsset('sneaky', 'dist/leak.mjs', sdir)).toBeNull();
    expect(resolveExtensionAsset('sneaky', 'escape/secret.txt', sdir)).toBeNull();
  });

  test('does not surface an extension whose funny.client escapes via symlink', () => {
    expect(discoverExtensions(sdir)).toEqual([]);
  });
});

describe('install + remove round-trip', () => {
  let target: string;
  let srcPkg: string;

  beforeAll(() => {
    target = mkdtempSync(join(tmpdir(), 'funny-ext-target-'));
    srcPkg = mkdtempSync(join(tmpdir(), 'funny-ext-src-'));
    mkdirSync(join(srcPkg, 'dist'), { recursive: true });
    writeFileSync(
      join(srcPkg, 'package.json'),
      JSON.stringify({
        name: '@acme/funny-visualizer-json',
        version: '2.1.0',
        description: 'JSON tree',
        funny: { client: 'dist/index.mjs' },
      }),
    );
    writeFileSync(join(srcPkg, 'dist', 'index.mjs'), 'export default {};');
  });

  afterAll(() => {
    rmSync(target, { recursive: true, force: true });
    rmSync(srcPkg, { recursive: true, force: true });
  });

  test('installs a local package and makes it discoverable', () => {
    const result = installExtensionFromPath(srcPkg, target);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.extension.id).toBe('@acme/funny-visualizer-json');
    expect(result.extension.name).toBe('acme-funny-visualizer-json'); // scope sanitized
    expect(listInstalledExtensions(target).map((e) => e.id)).toContain(
      '@acme/funny-visualizer-json',
    );
  });

  test('rejects a source without funny.client', () => {
    const bad = mkdtempSync(join(tmpdir(), 'funny-ext-bad-'));
    writeFileSync(join(bad, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0' }));
    expect(installExtensionFromPath(bad, target).ok).toBe(false);
    rmSync(bad, { recursive: true, force: true });
  });

  test('removes an installed extension by its dir name', () => {
    expect(listInstalledExtensions(target).length).toBeGreaterThan(0);
    expect(removeExtension('acme-funny-visualizer-json', target)).toEqual({ ok: true });
    expect(listInstalledExtensions(target)).toEqual([]);
  });

  test('remove refuses unsafe names and reports missing', () => {
    expect(removeExtension('../escape', target).ok).toBe(false);
    expect(removeExtension('nope', target)).toEqual({ ok: false, error: 'extension not found' });
  });
});

describe('extensionAssetContentType', () => {
  test('serves ESM/JS as text/javascript so the browser will execute it', () => {
    expect(extensionAssetContentType('x.mjs')).toContain('text/javascript');
    expect(extensionAssetContentType('x.js')).toContain('text/javascript');
  });

  test('maps other known types and defaults to octet-stream', () => {
    expect(extensionAssetContentType('x.css')).toContain('text/css');
    expect(extensionAssetContentType('x.json')).toContain('application/json');
    expect(extensionAssetContentType('x.bin')).toBe('application/octet-stream');
  });
});
