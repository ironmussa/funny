import { createHash } from 'crypto';
import { existsSync, readFileSync, realpathSync } from 'fs';
import { mkdir, rm, stat } from 'fs/promises';
import { homedir } from 'os';
import { resolve, dirname, basename, normalize, join, isAbsolute } from 'path';

import { badRequest, internal, type DomainError } from '@funny/shared/errors';
import { ResultAsync } from 'neverthrow';

import type { SetupProgressFn } from '../ports/setup-progress.js';
import { toDomainError } from './errors.js';
import { getNativeGit } from './native.js';
import { validatePath } from './path-validation.js';
import { gitRead, gitWrite, nativeGitWrite } from './process.js';

/**
 * Security HI-4: pure predicate that decides whether a path is *safe* to
 * pass to `git config --global --add safe.directory ...`. Extracted from
 * `ensureSafeDirectory` so the guards can be unit-tested without mocking
 * the git CLI.
 *
 * Refuses paths that:
 *   - begin with `-` (would be interpreted as a `git config` flag),
 *   - are empty / non-string / contain NUL,
 *   - are non-absolute (no meaningful scope), or
 *   - live under a known system prefix.
 *
 * `safe.directory` is global state on the runner, so a missing guard
 * upstream would otherwise let an attacker-influenced project path
 * persistently widen what git trusts.
 */
export function shouldRegisterSafeDirectory(dirPath: unknown): boolean {
  if (typeof dirPath !== 'string' || dirPath.length === 0) return false;
  if (dirPath.startsWith('-')) return false;
  if (dirPath.includes('\0')) return false;
  if (!dirPath.startsWith('/') && !/^[a-zA-Z]:[\\/]/.test(dirPath)) return false;
  const SAFE_DIR_BLOCKED_PREFIXES = ['/etc', '/proc', '/sys', '/dev', '/run', '/boot', '/root'];
  for (const prefix of SAFE_DIR_BLOCKED_PREFIXES) {
    if (dirPath === prefix || dirPath.startsWith(prefix + '/')) return false;
  }
  return true;
}

/**
 * Ensure a directory is registered as a git safe.directory so that
 * git doesn't reject operations when the directory owner differs from
 * the current user (common when the repo was created by a web server
 * or another process).
 *
 * Uses `git config --global --get-all` to check first and only adds
 * if not already present, so it's idempotent and safe to call repeatedly.
 */
async function ensureSafeDirectory(dirPath: string): Promise<void> {
  if (!shouldRegisterSafeDirectory(dirPath)) return;
  // Check if already registered
  const check = await gitRead(['config', '--global', '--get-all', 'safe.directory'], {
    reject: false,
  });
  if (check.exitCode === 0) {
    const existing = check.stdout.split('\n').map((l) => l.trim());
    if (existing.includes(dirPath)) return;
  }
  // Add to global config. The leading-`-` guard above is the actual defense
  // against flag-injection — `git config` doesn't honour `--` as a positional
  // separator the way most porcelain commands do.
  await gitWrite(['config', '--global', '--add', 'safe.directory', dirPath], {
    reject: false,
  });
}

/**
 * Drop a directory from the global safe.directory list. Every worktree used to
 * leave its entry behind, so ~/.gitconfig grew by one line per worktree ever
 * created. `--fixed-value` matches the path literally, not as a regex.
 */
async function forgetSafeDirectory(dirPath: string): Promise<void> {
  if (!shouldRegisterSafeDirectory(dirPath)) return;
  await gitWrite(
    ['config', '--global', '--fixed-value', '--unset-all', 'safe.directory', dirPath],
    {
      reject: false,
    },
  );
}

export const WORKTREE_DIR_NAME = '.funny-worktrees';

/**
 * Runner setting: the directory that holds every project's worktrees, instead
 * of a `.funny-worktrees` folder next to each project. Point it at a fast local
 * disk when projects live on a slow mount (an NTFS/FUSE drive, a network
 * share): the checkout and `bun install` then run there, and the package
 * manager can hardlink from its cache instead of copying every file.
 */
export const WORKTREE_ROOT_ENV = 'FUNNY_WORKTREE_ROOT';

type WorktreeEnv = Readonly<Record<string, string | undefined>>;

/** The configured worktree root, or null when unset or not absolute. */
export function configuredWorktreeRoot(env: WorktreeEnv = process.env): string | null {
  const raw = env[WORKTREE_ROOT_ENV]?.trim();
  if (!raw) return null;
  const expanded = raw === '~' || raw.startsWith('~/') ? join(homedir(), raw.slice(1)) : raw;
  return isAbsolute(expanded) ? resolve(expanded) : null;
}

/** The base next to the project: `<parent>/.funny-worktrees/<project>`. */
function siblingWorktreeBasePath(projectPath: string): string {
  return resolve(dirname(projectPath), WORKTREE_DIR_NAME, basename(projectPath));
}

/**
 * The base under the configured root. Several projects share that root, so the
 * folder carries a hash of the project path: two projects with the same name
 * must never share a base (`pruneOrphanWorktrees` deletes every folder of the
 * base that the project's git does not register).
 */
function rootWorktreeBasePath(root: string, projectPath: string): string {
  const absolute = resolve(projectPath);
  const hash = createHash('sha256').update(absolute).digest('hex').slice(0, 8);
  return resolve(root, WORKTREE_DIR_NAME, `${basename(absolute)}-${hash}`);
}

/** Where new worktrees of the project are created (the directory may not exist yet). */
export function getWorktreeBasePath(projectPath: string, env: WorktreeEnv = process.env): string {
  const root = configuredWorktreeRoot(env);
  return root ? rootWorktreeBasePath(root, projectPath) : siblingWorktreeBasePath(projectPath);
}

/**
 * Every base that may hold worktrees of the project: the current one first,
 * then the base next to the project. Worktrees created before
 * `FUNNY_WORKTREE_ROOT` was set stay valid, so path checks, cleanup and port
 * de-duplication must consider both.
 */
export function getWorktreeBasePaths(
  projectPath: string,
  env: WorktreeEnv = process.env,
): string[] {
  const current = getWorktreeBasePath(projectPath, env);
  const sibling = siblingWorktreeBasePath(projectPath);
  return current === sibling ? [current] : [current, sibling];
}

export function getWorktreeBase(projectPath: string): ResultAsync<string, DomainError> {
  const base = getWorktreeBasePath(projectPath);
  return ResultAsync.fromPromise(
    mkdir(base, { recursive: true }).then(() => base),
    (error) => internal(String(error)),
  );
}

export interface WorktreeInfo {
  path: string;
  branch: string;
  commit: string;
  isMain: boolean;
  lastActivityMs?: number;
}

export interface WorktreePreview {
  sanitizedBranchDir: string;
  branchName: string;
  worktreePath: string;
  alreadyExists: boolean;
}

export interface CreateWorktreeOptions {
  /**
   * Check out `branchName` when it already exists (and is not checked out in
   * another worktree) instead of failing: a retried issue-factory run goes on
   * from its earlier attempt on the same branch. `baseBranch` is then unused.
   */
  reuseExistingBranch?: boolean;
  /**
   * Start the new branch from the remote's copy of `baseBranch`
   * (`origin/<baseBranch>`, fetched first) instead of the local branch: the
   * issue factory's pull request must hold the agent's commits only, not the
   * ones the local base branch has and the remote lacks. Falls back to the
   * usual resolution when the remote has no such branch.
   */
  fromRemote?: boolean;
}

/** How long the fetch of a remote base may take before the last known ref is used. */
const REMOTE_BASE_FETCH_TIMEOUT_MS = 60_000;

/**
 * `origin/<baseBranch>` after a best-effort fetch, or null when the remote has
 * no such branch. A failed fetch (offline, no credentials) leaves the ref as
 * last fetched, which still excludes the local base's unpushed commits.
 *
 * The start point is its commit, not the ref: a branch created from a
 * remote-tracking ref gets that ref as its upstream, and the new branch must
 * not track the base branch (a pull would merge it, a push could target it).
 */
async function remoteBaseRef(
  projectPath: string,
  baseBranch: string,
): Promise<{ ref: string; commit: string } | null> {
  if (baseBranch.startsWith('-')) return null;
  await gitWrite(['fetch', 'origin', baseBranch], {
    cwd: projectPath,
    reject: false,
    timeout: REMOTE_BASE_FETCH_TIMEOUT_MS,
  }).catch(() => undefined);
  const remoteRef = `origin/${baseBranch}`;
  const check = await gitRead(
    ['rev-parse', '--verify', '--quiet', `refs/remotes/${remoteRef}^{commit}`],
    { cwd: projectPath, reject: false },
  );
  const commit = check.stdout.trim();
  return check.exitCode === 0 && commit ? { ref: remoteRef, commit } : null;
}

export function createWorktree(
  projectPath: string,
  branchName: string,
  baseBranch?: string,
  onProgress?: SetupProgressFn,
  { reuseExistingBranch = false, fromRemote = false }: CreateWorktreeOptions = {},
): ResultAsync<string, DomainError> {
  return ResultAsync.fromPromise(
    (async () => {
      // Ensure project path is a git safe.directory so commands don't fail
      // when the repo owner differs from the current user (e.g. www-data vs argenisleon).
      await ensureSafeDirectory(projectPath);

      // Ensure the repo has at least one commit — git worktree requires it.
      onProgress?.('worktree:init', 'Checking repository', 'running');
      const headResult = await gitRead(['rev-parse', 'HEAD'], {
        cwd: projectPath,
        reject: false,
      });
      if (headResult.exitCode !== 0) {
        const commitResult = await gitWrite(['commit', '--allow-empty', '-m', 'Initial commit'], {
          cwd: projectPath,
          reject: false,
        });
        if (commitResult.exitCode !== 0) {
          onProgress?.('worktree:init', 'Checking repository', 'failed');
          throw badRequest(
            `Cannot create worktree: the repository has no commits and the auto-commit failed: ${commitResult.stderr}`,
          );
        }
      }
      onProgress?.('worktree:init', 'Checking repository', 'completed');

      // Resolve the base branch ref. Try the name as-is first, then try
      // origin/<name> for remote-only branches (common after a fresh clone).
      let effectiveBase = baseBranch;
      const remoteBase =
        fromRemote && baseBranch ? await remoteBaseRef(projectPath, baseBranch) : null;
      if (remoteBase) {
        effectiveBase = remoteBase.commit;
        onProgress?.('worktree:resolve', `Using remote branch "${remoteBase.ref}"`, 'completed');
      } else if (baseBranch) {
        onProgress?.('worktree:resolve', `Resolving branch "${baseBranch}"`, 'running');
        const branchCheck = await gitRead(['rev-parse', '--verify', baseBranch], {
          cwd: projectPath,
          reject: false,
        });
        if (branchCheck.exitCode !== 0) {
          // Branch doesn't exist locally — try origin/<name>
          const remoteRef = `origin/${baseBranch}`;
          const remoteCheck = await gitRead(['rev-parse', '--verify', remoteRef], {
            cwd: projectPath,
            reject: false,
          });
          if (remoteCheck.exitCode === 0) {
            effectiveBase = remoteRef;
            onProgress?.(
              'worktree:resolve',
              `Using remote branch "origin/${baseBranch}"`,
              'completed',
            );
          } else {
            effectiveBase = undefined;
            onProgress?.(
              'worktree:resolve',
              `Branch "${baseBranch}" not found, using HEAD`,
              'completed',
            );
          }
        } else {
          onProgress?.('worktree:resolve', `Resolved branch "${baseBranch}"`, 'completed');
        }
      }

      const baseResult = await getWorktreeBase(projectPath);
      if (baseResult.isErr()) throw baseResult.error;
      const base = baseResult.value;
      // Sanitize branch name: strict whitelist, reject traversal attempts entirely
      if (/\.\./.test(branchName)) {
        throw badRequest('Branch name must not contain path traversal sequences (..)');
      }
      // Security L4: reject branch names that start with `-`. Git treats
      // leading-dash arguments as flags, so a value like `-rf` or `--exec=cmd`
      // could turn `git branch <name>` / `git worktree add -b <name>` into a
      // command-injection vector. The downstream `safeBranchDir` filter
      // doesn't help here because the *raw* `branchName` is what reaches git.
      if (branchName.startsWith('-')) {
        throw badRequest('Branch name must not start with "-"');
      }
      const safeBranchDir = branchName.replace(/[^a-zA-Z0-9._-]/g, '-'); // Keep only safe chars (no slashes)
      if (!safeBranchDir || safeBranchDir === '.' || safeBranchDir === '..') {
        throw badRequest('Invalid branch name after sanitization');
      }
      const worktreePath = pickWorktreePath(base, safeBranchDir);

      // Pre-register the worktree path as safe so subsequent git commands
      // inside the worktree don't fail due to ownership mismatch.
      await ensureSafeDirectory(worktreePath);

      // Only a branch this call creates may be deleted if the creation fails.
      const branchExisted =
        (
          await gitRead(['rev-parse', '--verify', '--quiet', `refs/heads/${branchName}`], {
            cwd: projectPath,
            reject: false,
          })
        ).exitCode === 0;

      const reuse = reuseExistingBranch && branchExisted;
      const source = reuse ? branchName : (effectiveBase ?? 'HEAD');
      onProgress?.('worktree:create', `Creating worktree from ${source}`, 'running');
      const result = await validatePath(projectPath).andThen((cwd) =>
        addWorktree(cwd, worktreePath, branchName, reuse ? null : (effectiveBase ?? 'HEAD')),
      );
      if (result.isErr()) {
        onProgress?.('worktree:create', `Creating worktree from ${source}`, 'failed');
        await discardFailedWorktree(projectPath, worktreePath, branchName, branchExisted);
        throw result.error;
      }
      onProgress?.('worktree:create', `Creating worktree from ${source}`, 'completed');
      return worktreePath;
    })(),
    (error) => {
      if ((error as DomainError).type) return error as DomainError;
      return internal(String(error));
    },
  );
}

/**
 * Runner setting: `1` makes worktree creation and removal always run
 * `git worktree add` / `remove` instead of trying gitoxide first.
 */
export const DISABLE_NATIVE_WORKTREE_ENV = 'FUNNY_DISABLE_NATIVE_WORKTREE';

/**
 * `git worktree add` for `branchName` at `worktreePath`: a new branch from
 * `startPoint`, or the existing branch when `startPoint` is null.
 *
 * Done in-process with gitoxide when the native module has it, which spares
 * a git process and its checkout. A remote-tracking start point gets the
 * upstream `git branch` would set. gitoxide runs no hooks, so the native side
 * declines repositories with a post-checkout or reference-transaction hook,
 * and also `branch.autoSetupMerge=always|inherit`, an ambiguous upstream and
 * stale `branch.<name>` config; git does those. A native
 * failure has already been rolled back (registration, files, the branch it
 * created), so git gets a clean second try and reports its own error.
 */
function addWorktree(
  cwd: string,
  worktreePath: string,
  branchName: string,
  startPoint: string | null,
): ResultAsync<void, DomainError> {
  const cli = () => {
    const args =
      startPoint === null
        ? ['worktree', 'add', worktreePath, branchName]
        : ['worktree', 'add', '-b', branchName, worktreePath, startPoint];
    // No deadline: the checkout of a large repository and its post-checkout
    // hook can take minutes, and killing git halfway leaves a broken worktree.
    return ResultAsync.fromPromise(gitWrite(args, { cwd, timeout: 0 }), toDomainError).map(
      () => undefined,
    );
  };
  const addNative = getNativeGit()?.addWorktree;
  if (!addNative || process.env[DISABLE_NATIVE_WORKTREE_ENV] === '1') return cli();
  const options =
    startPoint === null
      ? { branch: branchName, createBranch: false }
      : { branch: branchName, createBranch: true, startPoint };
  return ResultAsync.fromPromise(
    nativeGitWrite(cwd, () => addNative(cwd, worktreePath, options)),
    toDomainError,
  )
    .orElse(() => ResultAsync.fromSafePromise(Promise.resolve({ created: false })))
    .andThen((outcome) =>
      outcome.created ? ResultAsync.fromSafePromise(Promise.resolve()) : cli(),
    );
}

/** A path in a form two spellings of one folder share (symlinks resolved when it exists). */
function normalizeForCompare(path: string): string {
  try {
    return normalize(realpathSync(path));
  } catch {
    return normalize(resolve(path));
  }
}

/**
 * The folder a new worktree for `safeBranchDir` goes in: `<base>/<dir>`, or
 * `<dir>-2`, `<dir>-3`… when that is taken. A leftover folder (a worktree
 * deleted by hand) or two branches that sanitize alike (`feat/a`, `feat-a`)
 * must not block the creation. Stays a direct child of `base`, which
 * `assertWorktreeInProjectBase` requires.
 */
function pickWorktreePath(base: string, safeBranchDir: string): string {
  const first = resolve(base, safeBranchDir);
  let candidate = first;
  for (let suffix = 2; existsSync(candidate); suffix++) {
    candidate = `${first}-${suffix}`;
  }
  return candidate;
}

/**
 * Undo what a failed `git worktree add -b` left: its registration and folder
 * (git keeps both when the post-checkout hook fails) and the branch, unless
 * the branch existed before. Only a worktree registered at `worktreePath` on
 * `branchName` is removed, and git refuses to delete a branch checked out
 * elsewhere, so another worktree is never touched. Best effort.
 */
async function discardFailedWorktree(
  projectPath: string,
  worktreePath: string,
  branchName: string,
  branchExisted: boolean,
): Promise<void> {
  const listed = await gitRead(['worktree', 'list', '--porcelain'], {
    cwd: projectPath,
    reject: false,
  });
  const target = normalizeForCompare(worktreePath);
  const ours =
    listed.exitCode === 0 &&
    parseWorktreeListPorcelain(listed.stdout).some(
      (entry) => normalizeForCompare(entry.path) === target && entry.branch === branchName,
    );
  if (ours) await removeWorktree(projectPath, worktreePath);
  else await forgetSafeDirectory(worktreePath);
  await gitWrite(['worktree', 'prune'], { cwd: projectPath, reject: false });
  if (!branchExisted) await removeBranch(projectPath, branchName);
}

type WorktreeEntry = Omit<WorktreeInfo, 'isMain' | 'lastActivityMs'>;

/** Parse `git worktree list --porcelain` output. */
export function parseWorktreeListPorcelain(output: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let current: Partial<WorktreeInfo> = {};

  for (const raw of output.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.startsWith('worktree ')) {
      if (current.path) entries.push(current as WorktreeEntry);
      current = { path: line.slice('worktree '.length) };
    } else if (line.startsWith('HEAD ')) {
      current.commit = line.slice('HEAD '.length);
    } else if (line.startsWith('branch ')) {
      current.branch = line.slice('branch refs/heads/'.length);
    }
  }

  if (current.path) entries.push(current as WorktreeEntry);
  return entries;
}

/**
 * Registered worktrees (main first), read in-process with gitoxide when the
 * native module is available, else via `git worktree list` on the read pool.
 * It is a read: it must not take a write slot or bump the write generation,
 * which would invalidate every repository's cached git status.
 */
function readWorktreeEntries(projectPath: string): ResultAsync<WorktreeEntry[], DomainError> {
  return validatePath(projectPath).andThen((cwd) => {
    const cli = () =>
      ResultAsync.fromPromise(
        gitRead(['worktree', 'list', '--porcelain'], { cwd }),
        toDomainError,
      ).map((result) => parseWorktreeListPorcelain(result.stdout));
    const native = getNativeGit();
    if (!native) return cli();
    return ResultAsync.fromPromise(native.listWorktrees(cwd), toDomainError)
      .map((list) =>
        list.map((w) => ({ path: w.path, commit: w.commit, branch: w.branch }) as WorktreeEntry),
      )
      .orElse(() => cli());
  });
}

export function listWorktrees(projectPath: string): ResultAsync<WorktreeInfo[], DomainError> {
  return readWorktreeEntries(projectPath).andThen((entries) => {
    const normalizedProject = normalize(projectPath);

    return ResultAsync.fromPromise(
      Promise.all(
        entries.map(async (w) => ({
          ...w,
          isMain: normalize(w.path) === normalizedProject,
          lastActivityMs: (await getLastGitActivity(w.path)) ?? undefined,
        })),
      ),
      (error) => internal(String(error)),
    );
  });
}

export function findWorktreeForBranch(
  projectPath: string,
  branchName: string,
): ResultAsync<string | null, DomainError> {
  return listWorktrees(projectPath).map((worktrees) => {
    const match = worktrees.find((worktree) => worktree.branch === branchName);
    return match?.path ?? null;
  });
}

export function isRegisteredWorktreePath(
  projectPath: string,
  worktreePath: string,
): ResultAsync<boolean, DomainError> {
  if (
    typeof worktreePath !== 'string' ||
    worktreePath.length === 0 ||
    worktreePath.startsWith('-')
  ) {
    return ResultAsync.fromSafePromise(Promise.resolve(false));
  }

  const target = normalizeForCompare(worktreePath);
  return listWorktrees(projectPath).map((worktrees) =>
    worktrees.some((worktree) => normalizeForCompare(worktree.path) === target),
  );
}

/**
 * Security CR-3: verify that `worktreePath` is inside the project's worktree
 * base (`getWorktreeBasePath(projectPath)`) before any destructive operation.
 *
 * The route layer previously took `worktreePath` from the request body with
 * only a `z.string().min(1)` check, then passed it straight to
 * `git worktree remove -f` (which on failure was followed by an unconditional
 * `rm -rf`). That let an authenticated user delete arbitrary directories
 * writable by the runner UID — `~/.funny/encryption.key`, `~/.ssh`, source
 * trees, etc.
 *
 * Containment is enforced on the **realpath** of both ends so symlinks
 * cannot escape. Leading-`-` is also rejected to keep `git` from
 * interpreting the value as a flag.
 */
function assertWorktreeInProjectBase(
  projectPath: string,
  worktreePath: string,
): DomainError | null {
  if (typeof worktreePath !== 'string' || worktreePath.length === 0) {
    return badRequest('worktreePath is required');
  }
  if (worktreePath.startsWith('-')) {
    return badRequest('worktreePath must not start with "-"');
  }
  const realBases = getWorktreeBasePaths(projectPath).map((base) => {
    try {
      return realpathSync(base);
    } catch {
      // Base hasn't been created yet — fall back to the lexical path. No
      // worktrees can exist below it in that state anyway.
      return resolve(base);
    }
  });
  let realTarget: string;
  try {
    realTarget = realpathSync(worktreePath);
  } catch {
    // Target may already be gone — apply containment against the lexical
    // resolve so a missing dir doesn't bypass the check.
    realTarget = resolve(worktreePath);
  }
  // A worktree is always a direct child of the base (`createWorktree` strips
  // slashes from its directory name). The base itself or anything deeper
  // would make the `rm -rf` fallback delete other worktrees (issue #178).
  const isWorktreeDir = realBases.some(
    (realBase) => dirname(realTarget) === realBase && realTarget !== realBase,
  );
  if (!isWorktreeDir) {
    return badRequest(
      `worktreePath is not one of the project's worktree directories (project: ${projectPath})`,
    );
  }
  return null;
}

/**
 * `git worktree remove -f` in-process with gitoxide, which deletes the files
 * on several threads (a worktree with `node_modules` holds a great many).
 * False when the native module lacks it or it failed; the caller then runs
 * git, whose own fallback force-deletes what is left. The native side only
 * removes the worktree registered at exactly `worktreePath`.
 */
async function removeWorktreeNatively(projectPath: string, worktreePath: string): Promise<boolean> {
  const removeNative = getNativeGit()?.removeWorktree;
  if (!removeNative || process.env[DISABLE_NATIVE_WORKTREE_ENV] === '1') return false;
  return nativeGitWrite(projectPath, () => removeNative(projectPath, worktreePath)).then(
    () => true,
    () => false,
  );
}

/** Work in a worktree that exists nowhere else: removing the worktree loses it. */
export interface WorktreeUnsavedWork {
  /** Files changed or untracked and not committed. */
  dirtyFileCount: number;
  /** Commits on HEAD that no remote and no other local branch has. */
  unpushedCommitCount: number;
}

/**
 * Count the uncommitted files and the unpushed commits of a worktree, read from
 * git now (no cache): the answer decides whether the worktree may be deleted.
 * A git failure is an error, never "nothing to lose".
 *
 * A commit counts when only this worktree's branch has it. One that another
 * local branch has (a base branch ahead of its remote) survives the removal.
 */
export function worktreeUnsavedWork(
  worktreePath: string,
): ResultAsync<WorktreeUnsavedWork, DomainError> {
  return ResultAsync.fromPromise(
    (async () => {
      // Exits 1 on a detached HEAD: then no branch is left out below.
      const head = await gitRead(['symbolic-ref', '--short', '-q', 'HEAD'], {
        cwd: worktreePath,
        reject: false,
      });
      const ownBranch = head.exitCode === 0 ? head.stdout.trim() : '';
      const others = ownBranch ? [`--exclude=${ownBranch}`, '--branches'] : ['--branches'];
      const [status, unpushed] = await Promise.all([
        gitRead(['status', '--porcelain'], { cwd: worktreePath, reject: false }),
        gitRead(['rev-list', '--count', 'HEAD', '--not', '--remotes', ...others], {
          cwd: worktreePath,
          reject: false,
        }),
      ]);
      if (status.exitCode !== 0 || unpushed.exitCode !== 0) {
        throw internal(
          `Could not read the state of the worktree ${worktreePath}: ${(status.stderr || unpushed.stderr).trim()}`,
        );
      }
      return {
        dirtyFileCount: status.stdout.split('\n').filter((line) => line.trim() !== '').length,
        unpushedCommitCount: parseInt(unpushed.stdout.trim(), 10) || 0,
      };
    })(),
    (error) => {
      if ((error as DomainError).type) return error as DomainError;
      return internal(String(error));
    },
  );
}

export function removeWorktree(
  projectPath: string,
  worktreePath: string,
): ResultAsync<void, DomainError> {
  return ResultAsync.fromPromise(
    (async () => {
      const containmentErr = assertWorktreeInProjectBase(projectPath, worktreePath);
      if (containmentErr) throw containmentErr;

      if (await removeWorktreeNatively(projectPath, worktreePath)) {
        await forgetSafeDirectory(worktreePath);
        return;
      }

      const result = await gitWrite(['worktree', 'remove', '-f', worktreePath], {
        cwd: projectPath,
        reject: false,
      });

      // If git worktree remove succeeded or the directory is already gone, we're done.
      if (result.exitCode === 0 || !existsSync(worktreePath)) {
        await forgetSafeDirectory(worktreePath);
        return;
      }

      // Fallback: on Windows, file locks (antivirus, IDE, stale processes) commonly
      // prevent `git worktree remove`. Force-delete the directory, then prune the
      // worktree bookkeeping so git stays consistent.
      //
      // Re-verify containment immediately before the rm — even though the
      // path was checked up-front, defense-in-depth catches any code path
      // that swaps the variable between then and now.
      const recheck = assertWorktreeInProjectBase(projectPath, worktreePath);
      if (recheck) throw recheck;
      await rm(worktreePath, { recursive: true, force: true });
      await gitWrite(['worktree', 'prune'], { cwd: projectPath, reject: false });

      if (existsSync(worktreePath)) {
        throw internal(
          `Failed to remove worktree directory: ${worktreePath} — ${result.stderr.trim()}`,
        );
      }
      await forgetSafeDirectory(worktreePath);
    })(),
    (error) => {
      if ((error as DomainError).type) return error as DomainError;
      return internal(String(error));
    },
  );
}

/**
 * Remove safe.directory entries left by worktrees that no longer exist (from
 * before removeWorktree cleaned up after itself). Only entries inside a
 * `.funny-worktrees` directory are considered, so a user's own entries are
 * never touched. Resolves to the number of entries removed.
 */
export function pruneStaleWorktreeSafeDirectories(): ResultAsync<number, DomainError> {
  return ResultAsync.fromPromise(
    (async () => {
      const listed = await gitRead(['config', '--global', '--get-all', 'safe.directory'], {
        reject: false,
      });
      // Exit 1 means the key is absent: nothing to prune.
      if (listed.exitCode !== 0) return 0;
      const marker = `/${WORKTREE_DIR_NAME}/`;
      const stale = [
        ...new Set(
          listed.stdout
            .split('\n')
            .map((line) => line.trim())
            .filter((dir) => dir.replace(/\\/g, '/').includes(marker) && !existsSync(dir)),
        ),
      ];
      for (const dir of stale) await forgetSafeDirectory(dir);
      return stale.length;
    })(),
    (error) => internal(String(error)),
  );
}

/**
 * Public helper for callers (route layer, thread resolvers) that need to
 * confirm a path is one of a project's worktree directories (a direct child
 * of its worktree base) before consuming it as a cwd or destructive target.
 * Returns null if valid, a DomainError otherwise. Uses realpath so symlinks
 * cannot escape.
 */
export function checkWorktreePathInProject(
  projectPath: string,
  worktreePath: string,
): DomainError | null {
  return assertWorktreeInProjectBase(projectPath, worktreePath);
}

export function removeBranch(
  projectPath: string,
  branchName: string,
): ResultAsync<void, DomainError> {
  // Security L4: never pass a value starting with `-` directly to git as an
  // argument — it would be interpreted as a flag (potentially something like
  // `--exec=...`). The branch arg position here is positional but git's CLI
  // does not have a unanimous `--` separator across all commands; the safer
  // course is to reject the name outright. Caller is responsible for
  // surfacing this — `removeBranch` is best-effort cleanup that should never
  // execute on a hostile-looking name.
  if (branchName.startsWith('-')) {
    return ResultAsync.fromSafePromise(Promise.resolve());
  }
  return ResultAsync.fromPromise(
    gitWrite(['branch', '-D', '--', branchName], { cwd: projectPath, reject: false }).then(
      () => undefined,
    ),
    (error) => internal(String(error)),
  );
}

/**
 * Resolve the actual git directory for a worktree path.
 * For linked worktrees, `.git` is a file containing `gitdir: <path>`.
 * For the main worktree, `.git` is the directory itself.
 */
function resolveGitDir(worktreePath: string): string {
  const gitPath = join(worktreePath, '.git');
  try {
    const content = readFileSync(gitPath, 'utf-8');
    const match = content.match(/^gitdir:\s*(.+)/);
    if (match) return resolve(worktreePath, match[1].trim());
  } catch {
    // Not a file — likely the main worktree where .git is a directory
  }
  return gitPath;
}

/**
 * Get the last git activity timestamp for a worktree by checking
 * modification times of key git bookkeeping files.
 * Returns Unix milliseconds or null if no files could be stat'd.
 */
export async function getLastGitActivity(worktreePath: string): Promise<number | null> {
  const gitDir = resolveGitDir(worktreePath);
  const filesToCheck = [join(gitDir, 'index'), join(gitDir, 'HEAD'), join(gitDir, 'logs', 'HEAD')];

  let latestMs = 0;
  for (const file of filesToCheck) {
    try {
      const st = await stat(file);
      if (st.mtimeMs > latestMs) latestMs = st.mtimeMs;
    } catch {
      // File may not exist
    }
  }
  return latestMs > 0 ? latestMs : null;
}

/**
 * Preview a worktree creation without actually creating it.
 * Returns the sanitized directory name, branch name, path, and whether it already exists.
 */
/** Remove the folders of a worktree base that git no longer registers. */
async function pruneUnregisteredDirs(base: string, registeredPaths: Set<string>): Promise<number> {
  let pruned = 0;
  try {
    const { readdir } = await import('fs/promises');
    const entries = await readdir(base, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dirPath = normalize(resolve(base, entry.name));
      if (registeredPaths.has(dirPath)) continue;
      try {
        await rm(dirPath, { recursive: true, force: true });
        pruned++;
      } catch {
        // Best-effort cleanup
      }
    }
  } catch {
    // Base directory unreadable — nothing to prune
  }
  return pruned;
}

/**
 * Prune orphan worktrees for a given project path.
 * Runs `git worktree prune` to clean up stale bookkeeping entries,
 * then removes any leftover directories under the worktree base that
 * are no longer registered with git.
 */
export function pruneOrphanWorktrees(projectPath: string): ResultAsync<number, DomainError> {
  return ResultAsync.fromPromise(
    (async () => {
      // Run git worktree prune to clean stale entries
      await gitWrite(['worktree', 'prune'], { cwd: projectPath, reject: false });

      const bases = getWorktreeBasePaths(projectPath).filter((base) => existsSync(base));
      if (bases.length === 0) return 0;

      // List registered worktrees
      const listResult = await readWorktreeEntries(projectPath);
      // Without the registered list every directory would look orphaned and
      // be deleted, including live worktrees: skip the cleanup instead.
      if (listResult.isErr()) return 0;
      const registeredPaths = new Set<string>(listResult.value.map((w) => normalize(w.path)));

      let pruned = 0;
      for (const base of bases) pruned += await pruneUnregisteredDirs(base, registeredPaths);
      return pruned;
    })(),
    (error) => internal(String(error)),
  );
}

export function previewWorktree(
  projectPath: string,
  branchName: string,
): ResultAsync<WorktreePreview, DomainError> {
  return ResultAsync.fromPromise(
    (async () => {
      // Security L4: leading `-` would be a CLI flag once the caller acts on
      // the preview (e.g. via `worktree add -b <name>`). Reject up front so
      // the UI gets a clear error instead of executing a flag injection.
      if (branchName.startsWith('-')) {
        throw badRequest('Branch name must not start with "-"');
      }
      const base = getWorktreeBasePath(projectPath);
      const safeBranchDir = branchName.replace(/[^a-zA-Z0-9._-]/g, '-');
      const preferredPath = resolve(base, safeBranchDir);
      return {
        sanitizedBranchDir: safeBranchDir,
        branchName,
        // Where createWorktree would put it; `alreadyExists` means the
        // preferred folder is taken, so a numbered sibling is used instead.
        worktreePath: pickWorktreePath(base, safeBranchDir),
        alreadyExists: existsSync(preferredPath),
      };
    })(),
    (error) => internal(String(error)),
  );
}
