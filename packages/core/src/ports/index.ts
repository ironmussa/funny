import { existsSync, readdirSync, readFileSync } from 'fs';
import { resolve } from 'path';

import { executeShell } from '../git/process.js';
import { getWorktreeBase } from '../git/worktree.js';
import { readProjectConfig } from './config-reader.js';
import { copyAndOverrideEnv, readAllocatedPorts } from './env-writer.js';
import { allocatePorts } from './port-allocator.js';

export type { PortAllocation } from './port-allocator.js';
export { readProjectConfig } from './config-reader.js';
export { isPortAvailable, findAvailablePort, allocatePorts } from './port-allocator.js';
export { copyAndOverrideEnv, readAllocatedPorts } from './env-writer.js';

export interface SetupWorktreeResult {
  ports: Awaited<ReturnType<typeof allocatePorts>>;
  postCreateErrors: string[];
}

export type SetupProgressFn = (
  step: string,
  label: string,
  status: 'running' | 'completed' | 'failed',
  error?: string,
) => void;

/**
 * Full worktree setup: allocate ports, copy .env files, run postCreate commands.
 * Reads .funny.json from the project root. No-op if no config exists.
 */
export async function setupWorktree(
  projectPath: string,
  worktreePath: string,
  onProgress?: SetupProgressFn,
): Promise<SetupWorktreeResult> {
  const config = readProjectConfig(projectPath);
  const result: SetupWorktreeResult = { ports: [], postCreateErrors: [] };

  if (!config) return result;

  // 1. Port allocation + .env copy
  if (config.portGroups?.length && config.envFiles?.length) {
    onProgress?.('ports', 'Allocating ports', 'running');
    try {
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
    } catch (err) {
      onProgress?.('ports', 'Allocating ports', 'failed', String(err));
      throw err;
    }
  }

  // 2. Post-create commands
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
}

// Keep backward-compatible export
export const allocateWorktreePorts = setupWorktree;

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

  const worktreeBase = await getWorktreeBase(projectPath);

  if (!existsSync(worktreeBase)) return ports;

  try {
    const entries = readdirSync(worktreeBase, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const siblingPath = resolve(worktreeBase, entry.name);
      if (siblingPath === currentWorktreePath) continue;

      const siblingPorts = readAllocatedPorts(siblingPath, envFiles);
      for (const p of siblingPorts) ports.add(p);
    }
  } catch {
    // Best-effort: if we can't read siblings, skip deduplication
  }

  return ports;
}
