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
import { realpathSync } from 'fs';
import { homedir, platform } from 'os';
import { basename, dirname, normalize, resolve, sep } from 'path';

import { WORKTREE_DIR_NAME } from '@funny/core/git';

import { log } from '../lib/logger.js';
import { getServices } from '../services/service-registry.js';

/**
 * Security HI-2: resolve a path through realpath so symlinks cannot escape
 * the picker / project scope. If the target itself doesn't exist (common for
 * "about to create a directory" cases), walk up to the deepest existing
 * ancestor, realpath that, then re-attach the missing tail lexically.
 *
 * The lexical fallback for the missing tail is safe because the user can't
 * traverse through a non-existent component, so any symlink shenanigans must
 * live in the existing ancestor chain — which we DO realpath.
 *
 * Pure function; never throws; never returns undefined.
 */
function realpathOrAnchor(target: string): string {
  let current = normalize(resolve(target));
  const missing: string[] = [];
  // Walk up until realpath succeeds OR we hit the filesystem root.
  // Capped at 64 iterations as a defense against pathological loops.
  for (let i = 0; i < 64; i++) {
    try {
      const real = realpathSync(current);
      return missing.length === 0 ? real : resolve(real, ...missing.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return resolve(target); // hit root, give up
      missing.push(basename(current));
      current = parent;
    }
  }
  return resolve(target);
}

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

  // Security HI-2: check containment against the realpath, not just the
  // lexical resolve. Without this, a symlink in $HOME whose target is /etc
  // (or /home/otheruser) passes the lexical check and the route's
  // `readdirSync` then follows the symlink and enumerates the system dir.
  // The lexical resolve stays for `..` detection and Windows-root validation
  // (which must run BEFORE realpath because Windows realpath behaves
  // differently). The realpath check runs after.
  const lexicalTarget = normalize(resolve(path));
  const realTarget = realpathOrAnchor(path);

  if (platform() === 'win32') {
    if (!/^[a-z]:[\\/]/i.test(lexicalTarget)) return deny(403, 'Access denied');
    for (const prefix of BLOCKED_WINDOWS_PREFIXES) {
      if (
        isUnderCaseInsensitive(lexicalTarget, prefix) ||
        isUnderCaseInsensitive(realTarget, prefix)
      ) {
        log.warn('Blocked browse request for Windows system dir', {
          namespace: 'browse',
          path: lexicalTarget,
          realPath: realTarget,
        });
        return deny(403, 'Access denied');
      }
    }
    return null;
  }

  const home = normalize(resolve(homedir()));
  const realHome = realpathOrAnchor(home);

  // Must live under $HOME. Check BOTH the lexical and the realpath against
  // $HOME (also realpath'd, in case the user's home is itself a symlink —
  // e.g. /home/user → /Users/user on macOS).
  if (!isUnder(lexicalTarget, home) && !isUnder(realTarget, realHome)) {
    log.warn('Blocked browse request outside $HOME', {
      namespace: 'browse',
      path: lexicalTarget,
      realPath: realTarget,
    });
    return deny(403, 'Access denied');
  }
  // Tightest check: even if lexical passes, realpath must also be inside
  // (real) $HOME — otherwise a $HOME symlink → /etc would slip through.
  if (!isUnder(realTarget, realHome)) {
    log.warn('Blocked browse request: symlink escape from $HOME', {
      namespace: 'browse',
      path: lexicalTarget,
      realPath: realTarget,
    });
    return deny(403, 'Access denied');
  }

  // Even inside $HOME, block credential/secret directories — check both
  // forms so a symlink can't masquerade.
  for (const dir of BLOCKED_HOME_DIRS) {
    const credPath = normalize(resolve(home, dir));
    const realCredPath = realpathOrAnchor(credPath);
    if (
      isUnder(lexicalTarget, credPath) ||
      isUnder(realTarget, credPath) ||
      isUnder(realTarget, realCredPath)
    ) {
      log.warn('Blocked browse request for credential dir', {
        namespace: 'browse',
        path: lexicalTarget,
        realPath: realTarget,
      });
      return deny(403, 'Access denied');
    }
  }

  // Defensive: BLOCKED_PREFIXES catches leftover edge cases (e.g. symlinks
  // in $HOME that resolve to /etc). Apply against the realpath since a
  // lexical /home/user/sneaky doesn't start with /etc.
  for (const p of BLOCKED_PREFIXES) {
    if (
      lexicalTarget === p ||
      lexicalTarget.startsWith(p + '/') ||
      realTarget === p ||
      realTarget.startsWith(p + '/')
    ) {
      log.warn('Blocked browse request for system dir', {
        namespace: 'browse',
        path: lexicalTarget,
        realPath: realTarget,
        prefix: p,
      });
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
  // Security HI-2: same symlink-escape defense as `requirePickerPath`.
  // A user can create a symlink inside their project (`ln -s /etc proj/sneaky`)
  // then call file/git endpoints on `proj/sneaky/passwd` — without realpath
  // the lexical check passes because the path starts with the project dir.
  const lexicalTarget = normalize(resolve(path));
  const realTarget = realpathOrAnchor(path);
  const projects = await getServices().projects.listProjects(userId);
  for (const project of projects) {
    const projectPath = normalize(resolve(project.path));
    const realProjectPath = realpathOrAnchor(projectPath);
    if (isUnder(lexicalTarget, projectPath) && isUnder(realTarget, realProjectPath)) return null;
    const worktreeBase = normalize(
      resolve(dirname(projectPath), WORKTREE_DIR_NAME, basename(projectPath)),
    );
    const realWorktreeBase = realpathOrAnchor(worktreeBase);
    if (isUnder(lexicalTarget, worktreeBase) && isUnder(realTarget, realWorktreeBase)) return null;
  }

  log.warn('Rejected path outside user projects', {
    namespace: 'browse',
    userId,
    path: lexicalTarget,
    realPath: realTarget,
  });
  return new Response(
    JSON.stringify({ error: 'Access denied: path is outside allowed directories' }),
    { status: 403, headers: { 'Content-Type': 'application/json' } },
  );
}
