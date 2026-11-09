/**
 * The runner of a thread sandbox (change thread-sandboxes): provisioned by the
 * server on a machine the user never configured. Its env carries the sandbox's
 * LLM proxy token, which no other runner has.
 */

import type { ResolvedAgentExecutionProfileResponse } from '@funny/shared';

export function isSandboxRunner(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return !!env.FUNNY_LLM_PROXY_TOKEN?.trim();
}

/**
 * An agent profile as it applies on this runner. A profile's `CLAUDE_CONFIG_DIR`
 * is a directory on the user's own machine (e.g. `/home/me/.claude-work`); on a
 * sandbox it does not exist and cannot be created, so Claude could not save its
 * transcript and every follow-up failed to resume. Sandboxes use the default
 * config dir instead (their credential comes through the LLM proxy anyway).
 */
export function profileForThisRunner(
  resolved: ResolvedAgentExecutionProfileResponse,
  env: Readonly<Record<string, string | undefined>> = process.env,
): ResolvedAgentExecutionProfileResponse {
  if (!isSandboxRunner(env) || !('CLAUDE_CONFIG_DIR' in resolved.env)) return resolved;
  const { CLAUDE_CONFIG_DIR: _machinePath, ...portable } = resolved.env;
  return { ...resolved, env: portable };
}
