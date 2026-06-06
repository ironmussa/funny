/**
 * The `client` (visualizer) kind of the funny extension system. Extensions are
 * global to the server and live on disk at `<DATA_DIR>/extensions/<dirName>/`,
 * each a self-contained pre-built ESM package whose `package.json` points at its
 * client entry via a `funny.client` field:
 *
 *   { "name": "...", "version": "...", "funny": { "client": "dist/index.mjs" } }
 *
 * The browser fetches the manifest from `GET /api/extensions` and dynamically
 * imports each `entryUrl`, served by `GET /extensions/<dirName>/<file>`.
 *
 * The kind-agnostic machinery (dir scan, install/remove, git-spec validation,
 * symlink/traversal guards) lives in `@funny/core/extensions` and is shared with
 * the runner's `provider` kind. This module is the `client` handler on top of
 * it; the public API (and the loader/route contract) is unchanged.
 */
import { existsSync, realpathSync, statSync } from 'fs';
import { join, resolve } from 'path';

import {
  installPackageFromGit,
  installPackageFromPath,
  isInside,
  readPackageJson,
  removeExtensionDir,
  scanExtensions,
  type RemoveResult,
} from '@funny/core/extensions';

import { DATA_DIR } from './data-dir.js';

export { parseGitSpec, type GitSpec, type GitSpecResult } from '@funny/core/extensions';

export const EXTENSIONS_DIR = join(DATA_DIR, 'extensions');

/** Loader manifest entry (what the client dynamically imports). */
export interface ExtensionManifestEntry {
  id: string;
  version: string;
  /** Same-origin URL the client imports, e.g.
   *  `/extensions/funny-visualizer-csv/dist/index.mjs`. */
  entryUrl: string;
}

/** Richer record for the management UI / CLI. */
export interface InstalledExtension extends ExtensionManifestEntry {
  /** On-disk directory name — the stable handle used to remove the extension. */
  name: string;
  description?: string;
}

export type InstallResult =
  | { ok: true; extension: InstalledExtension }
  | { ok: false; error: string };

/** Parse + validate a single extension directory as a `client` extension.
 *  Returns null if invalid. Canonicalizes paths through realpath so a symlinked
 *  entry can't escape. */
function readExtension(dir: string, dirName: string): InstalledExtension | null {
  if (dirName.startsWith('.') || dirName.includes('/') || dirName.includes('\\')) return null;
  const pkgDir = join(dir, dirName);
  try {
    if (!statSync(pkgDir).isDirectory()) return null;
    const pkg = readPackageJson(pkgDir);
    if (!pkg) return null;
    const clientEntry: unknown = pkg?.funny?.client;
    if (typeof clientEntry !== 'string' || clientEntry.length === 0) return null;
    const pkgDirReal = realpathSync(pkgDir);
    const entryAbs = realpathSync(resolve(pkgDirReal, clientEntry));
    if (!isInside(pkgDirReal, entryAbs) || entryAbs === pkgDirReal) return null;
    if (!statSync(entryAbs).isFile()) return null;
    const relEntry = clientEntry.replace(/^\.?[\\/]+/, '').replace(/\\/g, '/');
    return {
      name: dirName,
      id: typeof pkg.name === 'string' && pkg.name ? pkg.name : dirName,
      version: typeof pkg.version === 'string' && pkg.version ? pkg.version : '0.0.0',
      description: typeof pkg.description === 'string' ? pkg.description : undefined,
      entryUrl: `/extensions/${encodeURIComponent(dirName)}/${relEntry
        .split('/')
        .map(encodeURIComponent)
        .join('/')}`,
    };
  } catch {
    return null;
  }
}

/** Validate a SOURCE package is a `client` extension before install. */
function validateClientSource(pkg: Record<string, any>, src: string): string | null {
  const clientEntry = pkg?.funny?.client;
  if (typeof clientEntry !== 'string' || !clientEntry) {
    return 'package.json is missing the funny.client field';
  }
  const entryAbs = resolve(src, clientEntry);
  if (!isInside(src, entryAbs) || !existsSync(entryAbs) || !statSync(entryAbs).isFile()) {
    return `funny.client entry "${clientEntry}" was not found`;
  }
  return null;
}

const clientHandler = { validateSource: validateClientSource, read: readExtension };

/** Scan `<DATA_DIR>/extensions` for valid `client` extensions. */
export function listInstalledExtensions(dir: string = EXTENSIONS_DIR): InstalledExtension[] {
  return scanExtensions(dir, readExtension);
}

/** The loader manifest: just what the client needs to import + register. */
export function discoverExtensions(dir: string = EXTENSIONS_DIR): ExtensionManifestEntry[] {
  return listInstalledExtensions(dir).map(({ id, version, entryUrl }) => ({
    id,
    version,
    entryUrl,
  }));
}

/** Install a `client` extension by copying a local pre-built package directory. */
export function installExtensionFromPath(
  srcPath: string,
  dir: string = EXTENSIONS_DIR,
): InstallResult {
  const res = installPackageFromPath(srcPath, dir, clientHandler);
  return res.ok ? { ok: true, extension: res.value } : res;
}

/** Install a `client` extension by cloning a remote git repository. */
export async function installExtensionFromGit(
  spec: string,
  opts: { ref?: string; subdir?: string; dir?: string } = {},
): Promise<InstallResult> {
  const res = await installPackageFromGit(
    spec,
    { ref: opts.ref, subdir: opts.subdir, dir: opts.dir ?? EXTENSIONS_DIR },
    clientHandler,
  );
  return res.ok ? { ok: true, extension: res.value } : res;
}

/** Remove an installed extension by its on-disk directory name. */
export function removeExtension(name: string, dir: string = EXTENSIONS_DIR): RemoveResult {
  return removeExtensionDir(name, dir);
}

/**
 * Resolve an asset path requested via `/extensions/<name>/<relPath>` to an
 * absolute file on disk, guarding against path traversal AND symlink escape.
 * `resolve()` only normalizes the string, so a symlink like
 * `dist/leak.mjs -> /etc/passwd` would textually look "inside" the package;
 * canonicalizing with realpath before the containment check closes that.
 */
export function resolveExtensionAsset(
  name: string,
  relPath: string,
  dir: string = EXTENSIONS_DIR,
): string | null {
  if (!name || name.startsWith('.') || name.includes('/') || name.includes('\\')) return null;
  let extReal: string;
  let pkgDirReal: string;
  let targetReal: string;
  try {
    extReal = realpathSync(resolve(dir));
    pkgDirReal = realpathSync(resolve(dir, name));
  } catch {
    return null;
  }
  if (!isInside(extReal, pkgDirReal) || pkgDirReal === extReal) return null;
  try {
    targetReal = realpathSync(resolve(pkgDirReal, relPath));
  } catch {
    return null;
  }
  if (!isInside(pkgDirReal, targetReal) || targetReal === pkgDirReal) return null;
  try {
    if (!statSync(targetReal).isFile()) return null;
  } catch {
    return null;
  }
  return targetReal;
}

/** Content-Type for a served extension asset, by extension. */
export function extensionAssetContentType(filePath: string): string {
  if (filePath.endsWith('.mjs') || filePath.endsWith('.js'))
    return 'text/javascript; charset=utf-8';
  if (filePath.endsWith('.json')) return 'application/json; charset=utf-8';
  if (filePath.endsWith('.css')) return 'text/css; charset=utf-8';
  if (filePath.endsWith('.map')) return 'application/json; charset=utf-8';
  if (filePath.endsWith('.wasm')) return 'application/wasm';
  if (filePath.endsWith('.svg')) return 'image/svg+xml';
  return 'application/octet-stream';
}
