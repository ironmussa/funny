/**
 * Path authorization helpers for HTTP routes.
 *
 * Two scopes are enforced:
 *
 *   - **Project scope**: the path must resolve inside one of the caller's
 *     registered projects (or the project's worktree base). Used for
 *     endpoints that act on repository contents.
 *
 *   - **Picker scope**: the path may be anywhere the user might plausibly
 *     browse to pick a folder to turn into a new project. We allow the
 *     user's home directory and Windows drive roots, and reject sensitive
 *     system directories plus traversal sequences. This is deliberately
 *     wider than project scope because the UI uses these endpoints before
 *     any project exists.
 */
import { homedir, platform } from 'os';
import { basename, dirname, normalize, resolve, sep } from 'path';

import { WORKTREE_DIR_NAME } from '@funny/core/git';

import { log } from '../lib/logger.js';
import { getServices } from '../services/service-registry.js';

/** Directories that must never be listed or acted on via browse/file routes. */
const BLOCKED_PREFIXES = ['/etc', '/proc', '/sys', '/dev', '/run', '/boot', '/root', '/var'];

/** Credential/secret directory names that shouldn't be browsed even under $HOME. */
const BLOCKED_HOME_DIRS = new Set(['.ssh', '.aws', '.gnupg', '.kube', '.config/gcloud', '.docker']);

/**
 * Windows system roots that must never be enumerated by the picker. Without
 * this list a logged-in user can list `C:\Windows`, `C:\Program Files`, etc.,
 * leaking host configuration (Security M6). Matched case-insensitively.
 */
const BLOCKED_WINDOWS_PREFIXES = [
  'C:\\Windows',
  'C:\\Program Files',
  'C:\\Program Files (x86)',
  'C:\\ProgramData',
  'C:\\$Recycle.Bin',
  'C:\\System Volume Information',
];

function isUnderCaseInsensitive(normalizedTarget: string, scope: string): boolean {
  const t = normalizedTarget.toLowerCase();
  const s = normalize(resolve(scope)).toLowerCase();
  return t === s || t.startsWith(s + sep);
}

/**
 * True if `normalizedTarget` is `scope` or a descendant of `scope`.
 * Uses `path + sep` to prevent sibling-prefix matches (e.g. `/a/bc` under `/a/b`).
 */
export function isUnder(normalizedTarget: string, scope: string): boolean {
  const normScope = normalize(resolve(scope));
  return normalizedTarget === normScope || normalizedTarget.startsWith(normScope + sep);
}

function deny(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * 403 if `path` contains `..`, resolves outside the runner's $HOME (Unix) or
 * a drive root (Windows), or points at a credential directory.
 *
 * Picker scope is deliberately wider than project scope because the UI calls
 * these endpoints before any project exists. Callers that read/write repo
 * contents must use {@link requireProjectPath}.
 */
export async function requirePickerPath(path: string): Promise<Response | null> {
  if (path.includes('..')) return deny(400, 'Path traversal not allowed');

  const normalizedTarget = normalize(resolve(path));

  if (platform() === 'win32') {
    if (!/^[a-z]:[\\/]/i.test(normalizedTarget)) return deny(403, 'Access denied');
    for (const prefix of BLOCKED_WINDOWS_PREFIXES) {
      if (isUnderCaseInsensitive(normalizedTarget, prefix)) {
        log.warn('Blocked browse request for Windows system dir', {
          namespace: 'browse',
          path: normalizedTarget,
        });
        return deny(403, 'Access denied');
      }
    }
    return null;
  }

  const home = normalize(resolve(homedir()));

  // Must live under $HOME. This automatically excludes /home/otheruser,
  // /Users/otheruser, system dirs, etc.
  if (!isUnder(normalizedTarget, home)) {
    log.warn('Blocked browse request outside $HOME', {
      namespace: 'browse',
      path: normalizedTarget,
    });
    return deny(403, 'Access denied');
  }

  // Even inside $HOME, block credential/secret directories.
  for (const dir of BLOCKED_HOME_DIRS) {
    const credPath = normalize(resolve(home, dir));
    if (isUnder(normalizedTarget, credPath)) {
      log.warn('Blocked browse request for credential dir', {
        namespace: 'browse',
        path: normalizedTarget,
      });
      return deny(403, 'Access denied');
    }
  }

  // Defensive: if running as a non-$HOME system user the paths above can't
  // occur, but BLOCKED_PREFIXES catches leftover edge cases (e.g. symlinks in
  // $HOME that normalize to /etc).
  for (const p of BLOCKED_PREFIXES) {
    if (normalizedTarget === p || normalizedTarget.startsWith(p + '/')) {
      return deny(403, 'Access denied');
    }
  }
  return null;
}

/**
 * 403 if `path` is not inside one of the caller's registered projects or
 * their worktree base. Use for endpoints that read/write repository contents.
 */
export async function requireProjectPath(path: string, userId: string): Promise<Response | null> {
  if (path.includes('..')) {
    return new Response(JSON.stringify({ error: 'Path traversal not allowed' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  const normalizedTarget = normalize(resolve(path));
  const projects = await getServices().projects.listProjects(userId);
  for (const project of projects) {
    const projectPath = normalize(resolve(project.path));
    if (isUnder(normalizedTarget, projectPath)) return null;
    const worktreeBase = normalize(
      resolve(dirname(projectPath), WORKTREE_DIR_NAME, basename(projectPath)),
    );
    if (isUnder(normalizedTarget, worktreeBase)) return null;
  }

  log.warn('Rejected path outside user projects', {
    namespace: 'browse',
    userId,
    path: normalizedTarget,
  });
  return new Response(
    JSON.stringify({ error: 'Access denied: path is outside allowed directories' }),
    { status: 403, headers: { 'Content-Type': 'application/json' } },
  );
}
