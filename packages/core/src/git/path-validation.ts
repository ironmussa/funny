import { accessSync, realpathSync } from 'fs';
import { access } from 'fs/promises';
import { homedir } from 'os';
import { basename, dirname, resolve, isAbsolute, sep } from 'path';

import { badRequest, forbidden, type DomainError } from '@funny/shared/errors';
import { ok, err, type Result, ResultAsync } from 'neverthrow';

/**
 * Validates that a path exists and is accessible (async).
 * Returns ResultAsync<string, DomainError>.
 */
export function validatePath(path: string): ResultAsync<string, DomainError> {
  if (!isAbsolute(path)) {
    return new ResultAsync(Promise.resolve(err(badRequest(`Path must be absolute: ${path}`))));
  }

  return ResultAsync.fromPromise(
    access(path).then(() => resolve(path)),
    () => badRequest(`Path does not exist or is not accessible: ${path}`),
  );
}

/**
 * Validates that a path exists and is accessible (sync).
 * Kept as throw-based for startup operations.
 * @throws Error if path is not absolute or doesn't exist
 */
export function validatePathSync(path: string): string {
  if (!isAbsolute(path)) {
    throw new Error(`Path must be absolute: ${path}`);
  }

  try {
    accessSync(path);
    return resolve(path);
  } catch {
    throw new Error(`Path does not exist or is not accessible: ${path}`);
  }
}

/**
 * Safely checks if a path exists without throwing
 */
export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Sanitizes a path to prevent directory traversal attacks.
 * Returns Result<string, DomainError>.
 */
export function sanitizePath(basePath: string, userPath: string): Result<string, DomainError> {
  const resolvedBase = resolve(basePath);
  const normalized = resolve(resolvedBase, userPath);

  if (!normalized.startsWith(resolvedBase)) {
    return err(forbidden('Path traversal detected'));
  }

  return ok(normalized);
}

// ── Project-root containment (security HI-3) ────────────────
//
// A project root, once registered, becomes the trusted scope for
// file/index/search/agent-spawn access on whichever host actually holds the
// files. These guards stop an authenticated user from registering `/etc`,
// system repos, or another tree as their project.
//
// IMPORTANT: containment is checked against the CURRENT process's `$HOME`
// (plus `FUNNY_PROJECT_ROOT`). That means this MUST run on the host that owns
// the filesystem — the runner in team mode, or the server in single-node mode.
// Running it on the server for a path that lives on a remote runner always
// rejects (the server's $HOME is unrelated), so callers in team mode delegate
// creation to the runner, which calls this against its own $HOME.

/** Unix-style absolute paths that must never become a project root. */
const PROJECT_BLOCKED_PREFIXES = [
  '/etc',
  '/proc',
  '/sys',
  '/dev',
  '/run',
  '/boot',
  '/root',
  '/var',
  '/usr',
  '/lib',
  '/lib64',
  '/sbin',
  '/bin',
  '/srv',
  '/opt/funny', // app's own install dir; never register itself
];

/** Windows-style system roots that must never become a project root. */
const PROJECT_BLOCKED_WINDOWS_PREFIXES = [
  'C:\\Windows',
  'C:\\Program Files',
  'C:\\Program Files (x86)',
  'C:\\ProgramData',
  'C:\\$Recycle.Bin',
  'C:\\System Volume Information',
];

/**
 * Realpath the deepest existing ancestor of `target`, then re-append the
 * not-yet-created trailing segments. Lets us resolve symlinks for a path that
 * doesn't fully exist yet (e.g. a clone destination) without throwing.
 */
function projectPathRealpathOrAnchor(target: string): string {
  let current = resolve(target);
  const missing: string[] = [];
  for (let i = 0; i < 64; i++) {
    try {
      const real = realpathSync(current);
      return missing.length === 0 ? real : resolve(real, ...missing.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return resolve(target);
      missing.push(basename(current));
      current = parent;
    }
  }
  return resolve(target);
}

function isUnderPath(target: string, scope: string): boolean {
  const t = target;
  const s = resolve(scope);
  return t === s || t.startsWith(s + sep);
}

function isUnderPathCaseInsensitive(target: string, scope: string): boolean {
  const t = target.toLowerCase();
  const s = resolve(scope).toLowerCase();
  return t === s || t.startsWith(s + sep);
}

/**
 * Lexical-only guards for a project root path — cheap checks that apply even
 * when the filesystem is not reachable (e.g. validating before a clone, or on
 * a host that does not hold the files). Returns the lexically-resolved path.
 */
export function validateProjectPathLexical(rawPath: string): Result<string, DomainError> {
  if (typeof rawPath !== 'string' || rawPath.length === 0) {
    return err(badRequest('Project path must be a non-empty string'));
  }
  if (rawPath.startsWith('-')) {
    return err(badRequest('Project path must not start with "-"'));
  }
  if (rawPath.includes('\0')) {
    return err(badRequest('Project path contains a null byte'));
  }
  if (!isAbsolute(rawPath)) {
    return err(badRequest('Project path must be absolute'));
  }
  if (rawPath.split(/[\\/]/).includes('..')) {
    return err(badRequest('Project path must not contain ".." segments'));
  }

  const lexical = resolve(rawPath);

  // Cross-platform: reject Unix system prefixes regardless of platform.
  for (const prefix of PROJECT_BLOCKED_PREFIXES) {
    if (lexical === prefix || lexical.startsWith(prefix + '/')) {
      return err(badRequest(`Project path is in a restricted system directory: ${prefix}`));
    }
  }
  for (const prefix of PROJECT_BLOCKED_WINDOWS_PREFIXES) {
    if (isUnderPathCaseInsensitive(lexical, prefix)) {
      return err(badRequest(`Project path is in a restricted system directory: ${prefix}`));
    }
  }

  return ok(lexical);
}

/**
 * Filesystem-aware containment: realpath the path (following symlinks),
 * re-check system prefixes against the realpath, and require it sits inside
 * the current process's `$HOME` — or an explicitly opted-in root via
 * `FUNNY_PROJECT_ROOT` (comma-separated). Returns the resolved realpath.
 *
 * MUST run on the host that owns the filesystem (see module note above).
 */
export function validateProjectRootContainment(rawPath: string): Result<string, DomainError> {
  const real = projectPathRealpathOrAnchor(rawPath);

  // Re-check prefixes against the realpath — a symlink at /home/user/sneaky
  // pointing to /etc would otherwise still slip through.
  for (const prefix of PROJECT_BLOCKED_PREFIXES) {
    if (real === prefix || real.startsWith(prefix + '/')) {
      return err(badRequest(`Project path resolves to a restricted system directory: ${prefix}`));
    }
  }
  for (const prefix of PROJECT_BLOCKED_WINDOWS_PREFIXES) {
    if (isUnderPathCaseInsensitive(real, prefix)) {
      return err(badRequest(`Project path resolves to a restricted system directory: ${prefix}`));
    }
  }

  const allowedRoots: string[] = [projectPathRealpathOrAnchor(homedir())];
  const extraRoots = process.env.FUNNY_PROJECT_ROOT;
  if (extraRoots) {
    for (const r of extraRoots
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)) {
      allowedRoots.push(projectPathRealpathOrAnchor(r));
    }
  }
  const allowed = allowedRoots.some((root) => isUnderPath(real, root));
  if (!allowed) {
    return err(
      badRequest(
        `Project path must live under $HOME (or a path in FUNNY_PROJECT_ROOT). Path resolves to: ${real}`,
      ),
    );
  }
  return ok(real);
}

/**
 * Full project-root validation: lexical guards followed by filesystem
 * containment. Returns the resolved realpath on success. Use on the host that
 * owns the files (the runner in team mode).
 */
export function validateProjectRootPath(rawPath: string): Result<string, DomainError> {
  return validateProjectPathLexical(rawPath).andThen(() => validateProjectRootContainment(rawPath));
}
