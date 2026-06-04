/**
 * Server-side discovery, management, and safe asset resolution for installed
 * client extensions (visualizer plugins). Extensions are global to the server
 * and live on disk at `<DATA_DIR>/extensions/<dirName>/`, each a self-contained
 * pre-built ESM package whose `package.json` points at its client entry via a
 * `funny.client` field:
 *
 *   { "name": "...", "version": "...", "funny": { "client": "dist/index.mjs" } }
 *
 * The browser fetches the manifest from `GET /api/extensions` and dynamically
 * imports each `entryUrl`, served by `GET /extensions/<dirName>/<file>`.
 */
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from 'fs';
import { basename, join, resolve, sep } from 'path';

import { DATA_DIR } from './data-dir.js';

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

export type RemoveResult = { ok: true } | { ok: false; error: string };

/** True when `child` is the same as, or nested inside, `parent`. */
function isInside(parent: string, child: string): boolean {
  const p = resolve(parent);
  const c = resolve(child);
  return c === p || c.startsWith(p + sep);
}

/** Turn an npm package name into a filesystem-safe directory name. */
function safeDirName(raw: string): string {
  return raw
    .replace(/^@/, '')
    .replace(/[/\\]+/g, '-')
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/^[.-]+/, '')
    .toLowerCase();
}

/** Parse + validate a single extension directory. Returns null if invalid.
 *  Canonicalizes paths through realpath so a symlinked entry can't escape. */
function readExtension(dir: string, dirName: string): InstalledExtension | null {
  if (dirName.startsWith('.') || dirName.includes('/') || dirName.includes('\\')) return null;
  const pkgDir = join(dir, dirName);
  try {
    if (!statSync(pkgDir).isDirectory()) return null;
    const pkgPath = join(pkgDir, 'package.json');
    if (!existsSync(pkgPath)) return null;
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
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

/** Scan `<DATA_DIR>/extensions` for valid extension packages. Malformed entries
 *  are skipped silently — one bad extension must not break the others. */
export function listInstalledExtensions(dir: string = EXTENSIONS_DIR): InstalledExtension[] {
  if (!existsSync(dir)) return [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: InstalledExtension[] = [];
  for (const name of names) {
    const ext = readExtension(dir, name);
    if (ext) out.push(ext);
  }
  return out;
}

/** The loader manifest: just what the client needs to import + register. */
export function discoverExtensions(dir: string = EXTENSIONS_DIR): ExtensionManifestEntry[] {
  return listInstalledExtensions(dir).map(({ id, version, entryUrl }) => ({
    id,
    version,
    entryUrl,
  }));
}

/**
 * Install an extension by copying a local pre-built package directory into the
 * extensions dir. The source must contain a `package.json` with a `funny.client`
 * entry that resolves to an existing file. Symlinks, `node_modules`, `.git` are
 * dropped from the copy.
 */
export function installExtensionFromPath(
  srcPath: string,
  dir: string = EXTENSIONS_DIR,
): InstallResult {
  let src: string;
  try {
    src = resolve(srcPath);
  } catch {
    return { ok: false, error: 'invalid source path' };
  }
  try {
    if (!statSync(src).isDirectory()) return { ok: false, error: 'source is not a directory' };
  } catch {
    return { ok: false, error: 'source path not found' };
  }
  const pkgPath = join(src, 'package.json');
  if (!existsSync(pkgPath)) return { ok: false, error: 'source has no package.json' };
  let pkg: { name?: unknown; funny?: { client?: unknown } };
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  } catch {
    return { ok: false, error: 'invalid package.json' };
  }
  const clientEntry = pkg?.funny?.client;
  if (typeof clientEntry !== 'string' || !clientEntry) {
    return { ok: false, error: 'package.json is missing the funny.client field' };
  }
  const entryAbs = resolve(src, clientEntry);
  if (!isInside(src, entryAbs) || !existsSync(entryAbs) || !statSync(entryAbs).isFile()) {
    return { ok: false, error: `funny.client entry "${clientEntry}" was not found` };
  }
  const dirName = safeDirName(typeof pkg.name === 'string' && pkg.name ? pkg.name : basename(src));
  if (!dirName) return { ok: false, error: 'could not derive a safe extension name' };
  const dest = resolve(dir, dirName);
  if (!isInside(dir, dest) || dest === resolve(dir))
    return { ok: false, error: 'unsafe destination' };

  try {
    mkdirSync(dir, { recursive: true });
    rmSync(dest, { recursive: true, force: true });
    cpSync(src, dest, {
      recursive: true,
      // Keep symlinks as links (don't follow), then drop them in the filter so
      // no symlink ever lands in the served tree.
      dereference: false,
      filter: (s) => {
        let st;
        try {
          st = lstatSync(s);
        } catch {
          return false;
        }
        if (st.isSymbolicLink()) return false;
        const b = basename(s);
        return b !== 'node_modules' && b !== '.git';
      },
    });
  } catch (err) {
    return { ok: false, error: `copy failed: ${String(err)}` };
  }

  const installed = readExtension(dir, dirName);
  if (!installed) return { ok: false, error: 'installed package was not discoverable' };
  return { ok: true, extension: installed };
}

/** Remove an installed extension by its on-disk directory name. */
export function removeExtension(name: string, dir: string = EXTENSIONS_DIR): RemoveResult {
  if (!name || name.startsWith('.') || name.includes('/') || name.includes('\\')) {
    return { ok: false, error: 'invalid extension name' };
  }
  const target = resolve(dir, name);
  if (!isInside(dir, target) || target === resolve(dir)) return { ok: false, error: 'unsafe name' };
  if (!existsSync(target)) return { ok: false, error: 'extension not found' };
  try {
    rmSync(target, { recursive: true, force: true });
  } catch (err) {
    return { ok: false, error: `remove failed: ${String(err)}` };
  }
  return { ok: true };
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
