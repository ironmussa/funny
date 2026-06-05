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
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from 'fs';
import { tmpdir } from 'os';
import { basename, join, resolve, sep } from 'path';

import { execute } from '@funny/core/git';

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

/** A validated git clone target derived from a user-supplied spec. */
export interface GitSpec {
  /** Clone URL, passed verbatim to `git clone` after a `--` separator. */
  url: string;
  /** Optional branch or tag to check out (shallow). */
  ref?: string;
}

export type GitSpecResult = { ok: true; spec: GitSpec } | { ok: false; error: string };

/** A git ref we'll pass to `git clone --branch`: branch/tag chars only, no
 *  leading dash (arg injection) and no `..` (path-ish escapes). */
function isValidGitRef(ref: string): boolean {
  return /^[\w][\w./-]*$/.test(ref) && !ref.includes('..');
}

/**
 * Parse + validate a git install spec into a safe `{ url, ref }`.
 *
 * Accepts only forms we can vouch for, because the URL is handed to `git clone`:
 *   - `github:user/repo` / `gh:user/repo`  → expanded to https
 *   - `https://host/path(.git)`
 *   - `git@host:path` (scp-style ssh) / `ssh://…`
 * Everything else is rejected — notably git's `ext::<cmd>` transport (which runs
 * an arbitrary command) and any URL that could be read as a `git` flag. A
 * trailing `#ref` selects a branch/tag.
 */
export function parseGitSpec(raw: string): GitSpecResult {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, error: 'empty git spec' };

  // A repo URL never contains '#', so a trailing '#…' is the ref selector.
  let url = trimmed;
  let ref: string | undefined;
  const hash = trimmed.indexOf('#');
  if (hash !== -1) {
    url = trimmed.slice(0, hash).trim();
    ref = trimmed.slice(hash + 1).trim() || undefined;
  }

  // Expand github:/gh: shorthand → https clone URL.
  const shorthand = /^(?:github|gh):([\w.-]+\/[\w.-]+?)(?:\.git)?$/i.exec(url);
  if (shorthand) url = `https://github.com/${shorthand[1]}.git`;

  const isHttps = /^https:\/\/\S+$/.test(url);
  const isSsh = /^(?:ssh:\/\/)?git@[\w.-]+:[\w./~-]+$/.test(url);
  if (!isHttps && !isSsh) {
    return {
      ok: false,
      error: 'unsupported git URL — use https://…, git@host:…, or github:user/repo',
    };
  }
  // Refuse argument injection (leading '-') and shell/transport metacharacters.
  if (url.startsWith('-') || /[\s'"\\;|&$`<>(){}]/.test(url)) {
    return { ok: false, error: 'git URL contains unsafe characters' };
  }
  if (ref !== undefined && !isValidGitRef(ref)) {
    return { ok: false, error: 'invalid git ref' };
  }
  return { ok: true, spec: { url, ref } };
}

/**
 * Install an extension by cloning a remote git repository. The repo (or an
 * optional subdirectory of it, for monorepos) must be a **pre-built** package:
 * its `package.json` `funny.client` must point at a committed bundle. We never
 * run the repo's build — matching the VSCode/Obsidian/npm norm where CI builds
 * the artifact and the installer only fetches + copies it.
 *
 * The clone is shallow, into a temp dir that is always removed, and uses a
 * whitelisted URL form (see {@link parseGitSpec}) with interactive auth prompts
 * disabled so a private/unknown repo fails fast instead of hanging.
 */
export async function installExtensionFromGit(
  spec: string,
  opts: { ref?: string; subdir?: string; dir?: string } = {},
): Promise<InstallResult> {
  const dir = opts.dir ?? EXTENSIONS_DIR;
  const parsed = parseGitSpec(spec);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  // An explicit ref option (CLI `--ref` / API `ref`) overrides an inline `#ref`.
  if (opts.ref?.trim()) {
    const ref = opts.ref.trim();
    if (!isValidGitRef(ref)) return { ok: false, error: 'invalid git ref' };
    parsed.spec.ref = ref;
  }

  // Validate the optional subdir before doing any work.
  let subdir = '';
  if (opts.subdir) {
    const s = opts.subdir.replace(/\\/g, '/').replace(/^\.?\/+/, '');
    if (s.startsWith('/') || s.split('/').includes('..')) {
      return { ok: false, error: 'invalid subdir' };
    }
    subdir = s;
  }

  let tmp: string;
  try {
    tmp = mkdtempSync(join(tmpdir(), 'funny-ext-git-'));
  } catch (err) {
    return { ok: false, error: `could not create temp dir: ${String(err)}` };
  }
  const checkout = join(tmp, 'repo');

  try {
    const args = ['clone', '--depth', '1'];
    if (parsed.spec.ref) args.push('--branch', parsed.spec.ref);
    args.push('--', parsed.spec.url, checkout);
    const res = await execute('git', args, {
      timeout: 120_000,
      reject: false,
      // Fail fast on private/unknown repos instead of blocking on a credential
      // prompt that has no TTY to answer it.
      env: { GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '/bin/echo', GCM_INTERACTIVE: 'never' },
    });
    if (res.exitCode !== 0) {
      const detail = (res.stderr || res.stdout).trim().split('\n').slice(-2).join(' ');
      return { ok: false, error: `git clone failed: ${detail || `exit ${res.exitCode}`}` };
    }

    const pkgRoot = subdir ? join(checkout, subdir) : checkout;
    if (!isInside(checkout, pkgRoot)) {
      return { ok: false, error: 'subdir escapes the repository' };
    }
    return installExtensionFromPath(pkgRoot, dir);
  } catch (err) {
    return { ok: false, error: `git install failed: ${String(err)}` };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
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
