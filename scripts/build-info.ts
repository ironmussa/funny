/**
 * Build identity — single source of truth.
 *
 * The "build number" is the git commit count (`git rev-list --count HEAD`):
 * a short, autoincremental integer that strictly grows with every commit. Two
 * people can compare it at a glance ("you're on 142, I'm on 139 → yours is
 * newer") without reading a long hash. The short hash is kept alongside for
 * exact identification.
 *
 * Computed at BUILD time and injected as the `__BUILD_INFO__` global via Vite's
 * `define` (client) and Bun.build's `define` (runtime/server). It is NOT
 * committed and never bumps the semver in package.json — semver stays an
 * intentional decision (`npm version patch|minor|major`).
 *
 * Build-time only (uses git + fs). Do not import from app runtime code paths.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface BuildInfo {
  /** Semver from the root package.json, e.g. "0.1.3". */
  version: string;
  /** Git commit count — short, autoincremental build number, e.g. 142. 0 when git is unavailable. */
  build: number;
  /** Short commit hash, e.g. "a1b2c3d", or "nogit" when unavailable. */
  commit: string;
  /** True when the working tree had uncommitted changes at build time. */
  dirty: boolean;
  /** Human-readable label, e.g. "0.1.3 · build 142 (a1b2c3d)". */
  label: string;
}

// Portable across Bun and Node: this module is imported both by Bun build
// scripts and by Vite's config loader (which runs under Node, where the
// Bun-only `import.meta.dir` is undefined).
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function git(...args: string[]): string | null {
  try {
    // execFileSync (no shell) — args are passed directly to git, never interpolated.
    return execFileSync('git', args, {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
  } catch {
    // Not a git repo (e.g. building from an npm tarball) — fall back gracefully.
    return null;
  }
}

export function getBuildInfo(): BuildInfo {
  const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as {
    version?: string;
  };
  const version = pkg.version ?? '0.0.0';

  const count = git('rev-list', '--count', 'HEAD');
  const build = count ? Number(count) : 0;
  const commit = git('rev-parse', '--short', 'HEAD') ?? 'nogit';
  const dirty = (git('status', '--porcelain') ?? '').length > 0;

  const label = build ? `${version} · build ${build} (${commit}${dirty ? '+' : ''})` : version;

  return { version, build, commit, dirty, label };
}

// CLI: `bun scripts/build-info.ts` prints the current build info as JSON.
if (import.meta.main) {
  console.log(JSON.stringify(getBuildInfo(), null, 2));
}
