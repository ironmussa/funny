import { execute, executeSync } from './process.js';
import { validatePath, validatePathSync } from './path-validation.js';
import type { FileDiff } from '@a-parallel/shared';

/**
 * Execute a git command safely with proper argument escaping
 */
export async function git(args: string[], cwd: string): Promise<string> {
  await validatePath(cwd);
  const { stdout } = await execute('git', args, { cwd });
  return stdout.trim();
}

/**
 * Execute a git command that may fail without throwing
 */
export async function gitSafe(
  args: string[],
  cwd: string
): Promise<string | null> {
  try {
    return await git(args, cwd);
  } catch {
    return null;
  }
}

/**
 * Check if a path is a git repository
 */
export async function isGitRepo(path: string): Promise<boolean> {
  const result = await gitSafe(['rev-parse', '--is-inside-work-tree'], path);
  return result === 'true';
}

/**
 * Execute a git command synchronously (use only when necessary, e.g. startup validation)
 */
export function gitSync(args: string[], cwd: string): string {
  validatePathSync(cwd);
  const { stdout } = executeSync('git', args, { cwd });
  return stdout.trim();
}

/**
 * Execute a git command synchronously that may fail without throwing
 */
export function gitSafeSync(args: string[], cwd: string): string | null {
  try {
    return gitSync(args, cwd);
  } catch {
    return null;
  }
}

/**
 * Check if a path is a git repository (synchronous version)
 */
export function isGitRepoSync(path: string): boolean {
  const result = gitSafeSync(['rev-parse', '--is-inside-work-tree'], path);
  return result === 'true';
}

/**
 * Get the current branch name
 */
export async function getCurrentBranch(cwd: string): Promise<string> {
  return git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
}

/**
 * List all branches in the repository
 */
export async function listBranches(cwd: string): Promise<string[]> {
  const output = await git(['branch', '--format=%(refname:short)'], cwd);
  return output.split('\n').map((b) => b.trim()).filter(Boolean);
}

/**
 * Get the remote URL for origin
 */
export async function getRemoteUrl(cwd: string): Promise<string | null> {
  return gitSafe(['remote', 'get-url', 'origin'], cwd);
}

/**
 * Extract repository name from remote URL
 */
export function extractRepoName(remoteUrl: string): string {
  // Extract repo name from URL like:
  // https://github.com/user/repo.git or git@github.com:user/repo.git
  return (
    remoteUrl
      .replace(/\.git$/, '')
      .split(/[/:]/)
      .pop() || ''
  );
}

/**
 * Initialize a new git repository
 */
export async function initRepo(cwd: string): Promise<void> {
  await git(['init'], cwd);
}

/**
 * Stage files for commit
 */
export async function stageFiles(cwd: string, paths: string[]): Promise<void> {
  if (paths.length === 0) return;

  // Use a single command for better performance
  if (paths.length === 1) {
    await git(['add', paths[0]], cwd);
  } else {
    // For multiple files, add them all at once
    await git(['add', ...paths], cwd);
  }
}

/**
 * Unstage files
 */
export async function unstageFiles(
  cwd: string,
  paths: string[]
): Promise<void> {
  if (paths.length === 0) return;

  for (const path of paths) {
    await git(['restore', '--staged', path], cwd);
  }
}

/**
 * Revert changes to files
 */
export async function revertFiles(cwd: string, paths: string[]): Promise<void> {
  if (paths.length === 0) return;

  for (const path of paths) {
    await git(['checkout', '--', path], cwd);
  }
}

/**
 * Create a commit with a message
 */
export async function commit(cwd: string, message: string): Promise<string> {
  return git(['commit', '-m', message], cwd);
}

/**
 * Push to remote
 */
export async function push(cwd: string): Promise<string> {
  const branch = await getCurrentBranch(cwd);
  return git(['push', '-u', 'origin', branch], cwd);
}

/**
 * Create a pull request using GitHub CLI
 */
export async function createPR(
  cwd: string,
  title: string,
  body: string
): Promise<string> {
  const { stdout } = await execute('gh', ['pr', 'create', '--title', title, '--body', body], {
    cwd,
    timeout: 30_000,
  });
  return stdout.trim();
}

/**
 * Parse git status line to extract file status
 */
function parseStatusLine(line: string): {
  status: FileDiff['status'];
  path: string;
} | null {
  const match = line.match(/^([MADR?])\s+(.+)$/);
  if (!match) return null;

  const statusMap: Record<string, FileDiff['status']> = {
    A: 'added',
    M: 'modified',
    D: 'deleted',
    R: 'renamed',
    '?': 'added',
  };

  return {
    status: statusMap[match[1]] ?? 'modified',
    path: match[2].trim(),
  };
}

/**
 * Get diff information for all changed files
 */
export async function getDiff(cwd: string): Promise<FileDiff[]> {
  // Get staged files
  const stagedRaw = (await gitSafe(['diff', '--staged', '--name-status'], cwd)) ?? '';
  const stagedFiles = stagedRaw
    .split('\n')
    .filter(Boolean)
    .map(parseStatusLine)
    .filter(Boolean) as { status: FileDiff['status']; path: string }[];

  // Get unstaged files
  const unstagedRaw = (await gitSafe(['diff', '--name-status'], cwd)) ?? '';
  const untrackedRaw =
    (await gitSafe(['ls-files', '--others', '--exclude-standard'], cwd)) ?? '';

  const unstagedFiles = unstagedRaw
    .split('\n')
    .filter(Boolean)
    .map(parseStatusLine)
    .filter(Boolean) as { status: FileDiff['status']; path: string }[];

  const untrackedFiles = untrackedRaw
    .split('\n')
    .filter(Boolean)
    .map((p) => ({ status: 'added' as const, path: p.trim() }));

  const allUnstaged = [...unstagedFiles, ...untrackedFiles];

  // Build FileDiff array with actual diff content
  const diffs: FileDiff[] = [];

  // Process staged files
  for (const f of stagedFiles) {
    const diffText = (await gitSafe(['diff', '--staged', '--', f.path], cwd)) ?? '';
    diffs.push({ path: f.path, status: f.status, diff: diffText, staged: true });
  }

  // Process unstaged files
  for (const f of allUnstaged) {
    // Skip if already in staged list
    if (stagedFiles.some((s) => s.path === f.path)) continue;
    const diffText = (await gitSafe(['diff', '--', f.path], cwd)) ?? '';
    diffs.push({ path: f.path, status: f.status, diff: diffText, staged: false });
  }

  return diffs;
}
