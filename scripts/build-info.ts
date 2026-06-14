/**
 * Build identity — single source of truth.
 *
 * The canonical identifier is the SHORT COMMIT SHA (first 8 hex of HEAD). It is
 * the ONE value that is identical in every build environment for a given commit:
 * locally it comes from `git`, and on a shallow-cloning PaaS (Railway/Railpack,
 * Docker builders without `.git`) it comes from the SHA the platform injects as
 * an env var. So a local build and the deployed server show the exact same
 * `0.1.3 (a1b2c3d4)` — never two different strings for the same commit.
 *
 * A commit COUNT (`git rev-list --count HEAD`) is also exposed as `build` when
 * git history is present, but it is metadata only — NOT the identity — because
 * it cannot be reproduced on a shallow clone, so showing it as the identifier
 * would make local and deploy disagree. `FUNNY_BUILD_NUMBER` can override it.
 *
 * Computed at BUILD time and injected as the `__BUILD_INFO__` global via Vite's
 * `define` (client) and Bun.build's `define` (runtime/server). It is NOT
 * committed and never bumps the semver in package.json — semver stays an
 * intentional decision (`npm version patch|minor|major`).
 *
 * Build-time only (uses git + fs + env). Do not import from app runtime paths.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface BuildInfo {
  /** Semver from the root package.json, e.g. "0.1.3". */
  version: string;
  /** Canonical identity: short commit SHA (first 8 hex), or "nogit" when unavailable. Identical in local + deploy. */
  commit: string;
  /** Metadata only — git commit count when history is present, else 0. NOT the identity (can't be reproduced on a shallow clone). */
  build: number;
  /** True when the working tree had uncommitted changes at build time. */
  dirty: boolean;
  /** Human-readable label, identical local + deploy for a commit, e.g. "0.1.3 (a1b2c3d4)". */
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

/** First non-empty value among the given env var names. */
function pickEnv(...keys: string[]): string | null {
  for (const key of keys) {
    const value = process.env[key]?.trim();
    if (value) return value;
  }
  return null;
}

export function getBuildInfo(): BuildInfo {
  const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as {
    version?: string;
  };
  const version = pkg.version ?? '0.0.0';

  // Canonical identity = short commit SHA. Take the FULL sha (from git locally,
  // else the SHA the build platform injects) and slice to a fixed 8 chars in
  // JS, so local and deploy produce a byte-identical string for the same commit.
  const fullSha =
    git('rev-parse', 'HEAD') ??
    pickEnv(
      'FUNNY_BUILD_COMMIT',
      'RAILWAY_GIT_COMMIT_SHA',
      'GITHUB_SHA',
      'VERCEL_GIT_COMMIT_SHA',
      'RENDER_GIT_COMMIT',
      'SOURCE_VERSION',
    );
  const commit = fullSha ? fullSha.slice(0, 8) : 'nogit';

  // Metadata only — never part of the identity (unavailable on shallow clones).
  const override = Number(process.env.FUNNY_BUILD_NUMBER);
  const count = git('rev-list', '--count', 'HEAD');
  const build = Number.isFinite(override) && override > 0 ? override : count ? Number(count) : 0;

  const dirty = (git('status', '--porcelain') ?? '').length > 0;

  const label = commit !== 'nogit' ? `${version} (${commit}${dirty ? '+' : ''})` : version;

  return { version, commit, build, dirty, label };
}

// CLI: `bun scripts/build-info.ts` prints the current build info as JSON.
if (import.meta.main) {
  console.log(JSON.stringify(getBuildInfo(), null, 2));
}
