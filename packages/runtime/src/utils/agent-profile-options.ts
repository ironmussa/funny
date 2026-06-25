/**
 * @domain subdomain: Agent Execution
 * @domain subdomain-type: generic
 * @domain type: adapter
 * @domain layer: infrastructure
 */

import { getServices } from '../services/service-registry.js';

export interface ClaudeProfileRouteOptions {
  claudeConfigDir?: string;
}

export async function resolveClaudeProfileRouteOptions(opts: {
  provider?: string;
  projectId?: string;
  userId?: string;
}): Promise<ClaudeProfileRouteOptions> {
  if (opts.provider !== 'claude' || !opts.projectId || !opts.userId) return {};

  const resolved = await getServices().agentProfiles.resolveEffectiveProfile(
    opts.projectId,
    opts.userId,
  );

  if (resolved.profile?.provider !== 'claude') return {};
  return { claudeConfigDir: resolved.env.CLAUDE_CONFIG_DIR };
}
