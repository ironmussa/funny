/**
 * The issue factory's git configuration for its agents (openspec
 * factory-integration 3.1): an implementing agent that merges the base in by
 * itself gets the same rerere and merge driver as the `integrate` step, through
 * `GIT_CONFIG_*` in its environment. Nothing is written to the repository's
 * config or attributes, which the user's own checkout shares.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

import { factoryGitConfigEnv } from '@funny/core/git';

/** Where the factory's git configuration files live on this runner. */
export const factoryGitDir = () => join(homedir(), '.funny', 'factory-git');

/**
 * `extra`'s `GIT_CONFIG_*` entries added after the ones `env` already has (or,
 * without them, the runner's own, which the agent inherits), so neither set
 * overwrites the other.
 */
export function appendGitConfigEnv(
  env: Record<string, string> | undefined,
  extra: Record<string, string>,
): Record<string, string> {
  const base = Number(env?.GIT_CONFIG_COUNT ?? process.env.GIT_CONFIG_COUNT ?? 0) || 0;
  const count = Number(extra.GIT_CONFIG_COUNT ?? 0) || 0;
  const merged: Record<string, string> = { ...env };
  for (let i = 0; i < count; i++) {
    const key = extra[`GIT_CONFIG_KEY_${i}`];
    const value = extra[`GIT_CONFIG_VALUE_${i}`];
    if (key === undefined || value === undefined) continue;
    merged[`GIT_CONFIG_KEY_${base + i}`] = key;
    merged[`GIT_CONFIG_VALUE_${base + i}`] = value;
  }
  if (count > 0) merged.GIT_CONFIG_COUNT = String(base + count);
  return merged;
}

/**
 * The agent's environment with the factory's git configuration, for a thread
 * the factory started that may write (a read-only role never merges).
 */
export async function withFactoryGitEnv<E extends Record<string, string> | undefined>(
  env: E,
  thread: { source?: string | null } | undefined,
  readOnly: boolean,
): Promise<E | Record<string, string>> {
  if (thread?.source !== 'factory' || readOnly) return env;
  const git = await factoryGitConfigEnv(factoryGitDir());
  if (git.isErr()) return env;
  return appendGitConfigEnv(env, git.value.env);
}
