import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
} from 'fs';
import { dirname, resolve } from 'path';

import { internal, type DomainError } from '@funny/shared/errors';
import { ResultAsync } from 'neverthrow';

import { executeShell } from '../git/process.js';
import { getWorktreeBasePaths } from '../git/worktree.js';
import { readProjectConfig } from './config-reader.js';
import { copyAndOverrideEnv, readAllocatedPorts } from './env-writer.js';
import { allocatePorts } from './port-allocator.js';

export type { PortAllocation } from './port-allocator.js';
export { readProjectConfig } from './config-reader.js';
export { readProcfile } from './procfile-reader.js';
export { isPortAvailable, findAvailablePort, allocatePorts } from './port-allocator.js';
export { copyAndOverrideEnv, readAllocatedPorts } from './env-writer.js';
export type { SetupProgressFn } from './setup-progress.js';

import type { SetupProgressFn } from './setup-progress.js';

export interface SetupWorktreeResult {
  ports: Awaited<ReturnType<typeof allocatePorts>>;
  postCreateErrors: string[];
}

const CLAUDE_PROJECT_ASSET_DIRS = ['.claude/commands', '.claude/skills'] as const;

/**
 * Full worktree setup: sync Claude assets, allocate ports, copy .env files,
 * run postCreate commands.
 * Reads .funny.json from the project root. No-op if no config exists.
 */
export function setupWorktree(
  projectPath: string,
  worktreePath: string,
  onProgress?: SetupProgressFn,
): ResultAsync<SetupWorktreeResult, DomainError> {
  return ResultAsync.fromPromise(
    (async () => {
      syncClaudeProjectAssets(projectPath, worktreePath);

      const config = readProjectConfig(projectPath);
      const result: SetupWorktreeResult = { ports: [], postCreateErrors: [] };

      if (!config) return result;

      // 1. Port allocation + .env copy
      if (config.portGroups?.length && config.envFiles?.length) {
        onProgress?.('ports', 'Allocating ports', 'running');
        const exclude = await collectSiblingPorts(projectPath, worktreePath, config.envFiles);
        result.ports = await allocatePorts(config.portGroups, exclude);

        for (const relPath of config.envFiles) {
          const relevantVars = detectRelevantVars(projectPath, relPath, result.ports);
          const filtered = result.ports
            .map((a) => ({
              ...a,
              envVars: a.envVars.filter((v) => relevantVars.has(v)),
            }))
            .filter((a) => a.envVars.length > 0);

          if (filtered.length > 0) {
            copyAndOverrideEnv(projectPath, worktreePath, relPath, filtered);
          }
        }
        onProgress?.('ports', 'Allocating ports', 'completed');
      }

      // 2. Post-create commands (best-effort — failures are collected, not fatal)
      if (config.postCreate?.length) {
        for (const cmd of config.postCreate) {
          const stepId = `cmd:${cmd}`;
          onProgress?.(stepId, cmd, 'running');
          try {
            await executeShell(cmd, { cwd: worktreePath, timeout: 120_000 });
            onProgress?.(stepId, cmd, 'completed');
          } catch (err) {
            const errMsg = String(err);
            result.postCreateErrors.push(`"${cmd}": ${errMsg}`);
            onProgress?.(stepId, cmd, 'failed', errMsg);
          }
        }
      }

      return result;
    })(),
    (err) => internal(`Worktree setup failed: ${err}`),
  );
}

// Keep backward-compatible export
export const allocateWorktreePorts = setupWorktree;

export function syncClaudeProjectAssets(projectPath: string, worktreePath: string): void {
  for (const relPath of CLAUDE_PROJECT_ASSET_DIRS) {
    const source = resolve(projectPath, relPath);
    if (!existsSync(source)) continue;

    const destination = resolve(worktreePath, relPath);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(source, destination, {
      recursive: true,
      force: true,
      errorOnExist: false,
      dereference: false,
      filter: (src, dest) => !isSameLink(src, dest),
    });
  }
}

/**
 * Whether `dest` is already a link to where the link `src` points. A worktree
 * is synced again on every agent start, and `cpSync` refuses to copy a link
 * over a link that resolves to the same directory (EINVAL, "subdirectory of
 * self"), which stopped the rest of the sync.
 */
function isSameLink(src: string, dest: string): boolean {
  try {
    if (!lstatSync(src).isSymbolicLink() || !lstatSync(dest).isSymbolicLink()) return false;
    return realpathSync(src) === realpathSync(dest);
  } catch {
    // A missing destination or a dangling link: let cpSync copy it.
    return false;
  }
}

/**
 * Check which port-related env vars already exist in the source .env file.
 * Only those vars will be overridden in the worktree copy.
 */
function detectRelevantVars(
  projectPath: string,
  relativeEnvPath: string,
  allocations: { envVars: string[] }[],
): Set<string> {
  const allPortVars = new Set<string>();
  for (const a of allocations) {
    for (const v of a.envVars) allPortVars.add(v);
  }

  const envPath = resolve(projectPath, relativeEnvPath);
  if (!existsSync(envPath)) return allPortVars; // New file — write all

  const content = readFileSync(envPath, 'utf-8');
  const found = new Set<string>();

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const varName = trimmed.slice(0, eqIdx).trim();
    if (allPortVars.has(varName)) found.add(varName);
  }

  return found;
}

async function collectSiblingPorts(
  projectPath: string,
  currentWorktreePath: string,
  envFiles: string[],
): Promise<Set<number>> {
  const ports = new Set<number>();

  // Worktrees made before FUNNY_WORKTREE_ROOT was set still hold ports.
  for (const worktreeBase of getWorktreeBasePaths(projectPath)) {
    for (const siblingPath of listSiblingWorktrees(worktreeBase, currentWorktreePath)) {
      for (const p of readAllocatedPorts(siblingPath, envFiles)) ports.add(p);
    }
  }

  return ports;
}

/** The other worktree folders of a base. Best-effort: an unreadable base lists none. */
function listSiblingWorktrees(worktreeBase: string, currentWorktreePath: string): string[] {
  if (!existsSync(worktreeBase)) return [];
  try {
    return readdirSync(worktreeBase, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => resolve(worktreeBase, entry.name))
      .filter((siblingPath) => siblingPath !== currentWorktreePath);
  } catch {
    return [];
  }
}
