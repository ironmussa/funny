import { existsSync, readdirSync } from 'fs';
import { mkdir } from 'fs/promises';
import { dirname } from 'path';

import { cloneRepo, getCurrentBranch, getDefaultBranch, git, isGitRepo } from '@funny/core/git';

import { buildAuthenticatedUrl, redactGitUrl, resolveGitCredentials } from './config.ts';
import type { PreparedWorkspace, RuntimeConfig } from './types.ts';

export async function prepareWorkspace(config: RuntimeConfig): Promise<PreparedWorkspace> {
  if (config.repoMode === 'mount') {
    return prepareMountedWorkspace(config);
  }
  return prepareCloneWorkspace(config);
}

export async function prepareCloneWorkspace(config: RuntimeConfig): Promise<PreparedWorkspace> {
  if (!config.repoUrl) {
    throw new Error('REPO_URL is required when REPO_MODE=clone');
  }

  await mkdir(dirname(config.workspacePath), { recursive: true });

  const alreadyCloned =
    existsSync(`${config.workspacePath}/.git`) && (await isGitRepo(config.workspacePath));
  let cloned = false;

  if (!alreadyCloned) {
    const credentials = resolveGitCredentials(config);
    const cloneUrl = credentials
      ? buildAuthenticatedUrl(config.repoUrl, credentials)
      : config.repoUrl;

    console.log(`[repo-workspace] Cloning ${config.repoUrl} -> ${config.workspacePath}`);
    const result = await cloneRepo(cloneUrl, config.workspacePath);
    if (result.isErr()) {
      throw new Error(redactCloneError(result.error.message));
    }
    cloned = true;
  } else {
    console.log(`[repo-workspace] Reusing existing clone at ${config.workspacePath}`);
  }

  const activeRef = await checkoutRef(config.workspacePath, config.repoRef);
  const workBranch = await createWorkBranch(config.workspacePath, config.workBranch);

  return {
    workspacePath: config.workspacePath,
    mode: 'clone',
    cloned,
    activeRef,
    workBranch,
  };
}

export async function prepareMountedWorkspace(config: RuntimeConfig): Promise<PreparedWorkspace> {
  if (!existsSync(config.workspacePath)) {
    throw new Error(`Mounted workspace not found: ${config.workspacePath}`);
  }

  const validRepo = await validateGitRepo(config.workspacePath);
  if (!validRepo) {
    throw new Error(`Mounted workspace is not a git repository: ${config.workspacePath}`);
  }

  console.log(`[repo-workspace] Using mounted repository at ${config.workspacePath}`);

  const activeRef = await checkoutRef(config.workspacePath, config.repoRef);
  const workBranch = await createWorkBranch(config.workspacePath, config.workBranch);

  return {
    workspacePath: config.workspacePath,
    mode: 'mount',
    cloned: false,
    activeRef,
    workBranch,
  };
}

export async function validateGitRepo(path: string): Promise<boolean> {
  if (!existsSync(path)) return false;
  if (!existsSync(`${path}/.git`)) return false;
  return isGitRepo(path);
}

export async function checkoutRef(cwd: string, repoRef?: string): Promise<string> {
  if (!repoRef) return getActiveRef(cwd);

  const directCheckout = await git(['checkout', repoRef], cwd);
  if (directCheckout.isOk()) {
    console.log(`[repo-workspace] Checked out ref: ${repoRef}`);
    return repoRef;
  }

  const remoteBranchCheckout = await git(['checkout', '-B', repoRef, `origin/${repoRef}`], cwd);
  if (remoteBranchCheckout.isOk()) {
    console.log(`[repo-workspace] Checked out remote branch: origin/${repoRef}`);
    return repoRef;
  }

  throw new Error(`Failed to checkout ref "${repoRef}"`);
}

export async function createWorkBranch(
  cwd: string,
  workBranch?: string,
): Promise<string | undefined> {
  if (!workBranch) return undefined;

  const current = await getCurrentBranch(cwd);
  if (current.isOk() && current.value === workBranch) {
    return workBranch;
  }

  const existing = await git(['checkout', workBranch], cwd);
  if (existing.isOk()) {
    console.log(`[repo-workspace] Checked out existing work branch: ${workBranch}`);
    return workBranch;
  }

  const created = await git(['checkout', '-b', workBranch], cwd);
  if (created.isErr()) {
    throw new Error(`Failed to create work branch "${workBranch}": ${created.error.message}`);
  }

  console.log(`[repo-workspace] Created work branch: ${workBranch}`);
  return workBranch;
}

async function getActiveRef(cwd: string): Promise<string> {
  const current = await getCurrentBranch(cwd);
  if (current.isOk()) return current.value;

  const fallback = await getDefaultBranch(cwd);
  if (fallback.isOk() && fallback.value) return fallback.value;

  return 'HEAD';
}

function redactCloneError(message: string): string {
  return redactGitUrl(message);
}

export function workspaceHasContent(path: string): boolean {
  if (!existsSync(path)) return false;
  return readdirSync(path).length > 0;
}
