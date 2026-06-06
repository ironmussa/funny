/**
 * Kind-agnostic core of the funny extension system. funny extensions are a
 * `package.json` whose `funny.<kind>` field points at the payload for that kind
 * — `funny.client` (a visualizer JS bundle, server-side) or `funny.provider`
 * (an ACP provider manifest, runner-side). The loading architecture is shared;
 * only the per-kind handler (and where it lives) differs.
 *
 * This module owns everything that does NOT depend on the kind: directory
 * scanning, the `package.json` envelope, safe dir-name derivation, git-spec
 * validation, the install/remove pipeline, and the symlink/traversal/realpath
 * guards. A kind handler supplies two callbacks:
 *   - `validateSource(pkg, srcDir)` → an error string, or null if the source is
 *     a valid extension of that kind (e.g. `funny.client` resolves to a file).
 *   - `read(dir, dirName)` → the kind's record, or null if invalid/not that kind.
 *
 * Extracted from the original server-only visualizer loader so the runner can
 * reuse the exact same machinery for provider extensions.
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

import { execute } from '../git/index.js';

// ── Path + name guards (pure) ─────────────────────────────────────────────

/** True when `child` is the same as, or nested inside, `parent`. */
export function isInside(parent: string, child: string): boolean {
  const p = resolve(parent);
  const c = resolve(child);
  return c === p || c.startsWith(p + sep);
}

/** Turn an npm package name into a filesystem-safe directory name. */
export function safeDirName(raw: string): string {
  return raw
    .replace(/^@/, '')
    .replace(/[/\\]+/g, '-')
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/^[.-]+/, '')
    .toLowerCase();
}

/** Read + JSON-parse a `package.json` from an extension dir. Null if missing/invalid. */
export function readPackageJson(pkgDir: string): Record<string, any> | null {
  try {
    const pkgPath = join(pkgDir, 'package.json');
    if (!existsSync(pkgPath)) return null;
    return JSON.parse(readFileSync(pkgPath, 'utf8')) as Record<string, any>;
  } catch {
    return null;
  }
}

// ── Generic directory scan ────────────────────────────────────────────────

/**
 * Scan `dir` for extension packages, parsing each child with a kind `parse`
 * callback. Malformed entries (parse → null) are skipped so one bad extension
 * never breaks the others. Dot-dirs and names with separators are refused.
 */
export function scanExtensions<T>(
  dir: string,
  parse: (dir: string, dirName: string) => T | null,
): T[] {
  if (!existsSync(dir)) return [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: T[] = [];
  for (const name of names) {
    if (name.startsWith('.') || name.includes('/') || name.includes('\\')) continue;
    const parsed = parse(dir, name);
    if (parsed) out.push(parsed);
  }
  return out;
}

// ── Git spec validation (pure) ────────────────────────────────────────────

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
export function isValidGitRef(ref: string): boolean {
  return /^[\w][\w./-]*$/.test(ref) && !ref.includes('..');
}

/**
 * Parse + validate a git install spec into a safe `{ url, ref }`. Accepts only
 * forms we can vouch for (the URL is handed to `git clone`): `github:`/`gh:`
 * shorthand, `https://…`, scp-style `git@host:path` / `ssh://…`. Rejects git's
 * `ext::<cmd>` transport and anything readable as a `git` flag. A trailing
 * `#ref` selects a branch/tag.
 */
export function parseGitSpec(raw: string): GitSpecResult {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, error: 'empty git spec' };

  let url = trimmed;
  let ref: string | undefined;
  const hash = trimmed.indexOf('#');
  if (hash !== -1) {
    url = trimmed.slice(0, hash).trim();
    ref = trimmed.slice(hash + 1).trim() || undefined;
  }

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
  if (url.startsWith('-') || /[\s'"\\;|&$`<>(){}]/.test(url)) {
    return { ok: false, error: 'git URL contains unsafe characters' };
  }
  if (ref !== undefined && !isValidGitRef(ref)) {
    return { ok: false, error: 'invalid git ref' };
  }
  return { ok: true, spec: { url, ref } };
}

// ── Install / remove pipeline (kind-agnostic) ─────────────────────────────

export type InstallResult<T> = { ok: true; value: T } | { ok: false; error: string };
export type RemoveResult = { ok: true } | { ok: false; error: string };

/** Callbacks a kind handler supplies to the generic install/scan. */
export interface KindHandler<T> {
  /** Validate the SOURCE package before copying. Returns an error, or null if ok. */
  validateSource: (pkg: Record<string, any>, srcDir: string) => string | null;
  /** Parse an installed extension dir into the kind's record, or null if invalid. */
  read: (dir: string, dirName: string) => T | null;
}

/**
 * Install an extension by copying a local pre-built package directory into
 * `dir`. The kind handler validates the source and reads the result back.
 * Symlinks, `node_modules`, and `.git` are dropped from the copy so no symlink
 * ever lands in the served/loaded tree.
 */
export function installPackageFromPath<T>(
  srcPath: string,
  dir: string,
  handler: KindHandler<T>,
): InstallResult<T> {
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
  const pkg = readPackageJson(src);
  if (!pkg) return { ok: false, error: 'source has no (valid) package.json' };

  const sourceError = handler.validateSource(pkg, src);
  if (sourceError) return { ok: false, error: sourceError };

  const dirName = safeDirName(typeof pkg.name === 'string' && pkg.name ? pkg.name : basename(src));
  if (!dirName) return { ok: false, error: 'could not derive a safe extension name' };
  const dest = resolve(dir, dirName);
  if (!isInside(dir, dest) || dest === resolve(dir)) {
    return { ok: false, error: 'unsafe destination' };
  }

  try {
    mkdirSync(dir, { recursive: true });
    rmSync(dest, { recursive: true, force: true });
    cpSync(src, dest, {
      recursive: true,
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

  const installed = handler.read(dir, dirName);
  if (!installed) return { ok: false, error: 'installed package was not discoverable' };
  return { ok: true, value: installed };
}

/**
 * Install an extension by cloning a remote git repo (or a subdir of it). The
 * repo must be a **pre-built** package — we never run its build, matching the
 * VSCode/Obsidian/npm norm. The clone is shallow, into an always-removed temp
 * dir, with a whitelisted URL ({@link parseGitSpec}) and interactive auth
 * disabled so a private/unknown repo fails fast instead of hanging.
 */
export async function installPackageFromGit<T>(
  spec: string,
  opts: { ref?: string; subdir?: string; dir: string },
  handler: KindHandler<T>,
): Promise<InstallResult<T>> {
  const parsed = parseGitSpec(spec);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  if (opts.ref?.trim()) {
    const ref = opts.ref.trim();
    if (!isValidGitRef(ref)) return { ok: false, error: 'invalid git ref' };
    parsed.spec.ref = ref;
  }

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
    return installPackageFromPath(pkgRoot, opts.dir, handler);
  } catch (err) {
    return { ok: false, error: `git install failed: ${String(err)}` };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Remove an installed extension by its on-disk directory name. */
export function removeExtensionDir(name: string, dir: string): RemoveResult {
  if (!name || name.startsWith('.') || name.includes('/') || name.includes('\\')) {
    return { ok: false, error: 'invalid extension name' };
  }
  const target = resolve(dir, name);
  if (!isInside(dir, target) || target === resolve(dir)) {
    return { ok: false, error: 'unsafe name' };
  }
  if (!existsSync(target)) return { ok: false, error: 'extension not found' };
  try {
    rmSync(target, { recursive: true, force: true });
  } catch (err) {
    return { ok: false, error: `remove failed: ${String(err)}` };
  }
  return { ok: true };
}

// Re-export realpath-based containment for kind handlers that resolve assets.
export { realpathSync };
