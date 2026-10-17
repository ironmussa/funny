import type { AgentProvider } from '@funny/shared';

import type { RuntimeThreadRecord } from '../server-interfaces.js';
import { getServices } from '../service-registry.js';

export interface ActiveAgentProfile {
  profile: { id: string; name: string; provider: string } | null;
  env: Record<string, string>;
}

const NO_PROFILE = (): ActiveAgentProfile => ({ profile: null, env: {} });

/**
 * Resolve the effective agent execution profile for the thread's project +
 * user. A profile only applies when it targets the provider being started.
 */
export async function resolveActiveAgentProfile(
  thread: RuntimeThreadRecord | undefined,
  provider: AgentProvider,
): Promise<ActiveAgentProfile> {
  if (!thread?.projectId || !thread?.userId) return NO_PROFILE();
  const resolved = await getServices().agentProfiles.resolveEffectiveProfile(
    thread.projectId,
    thread.userId,
  );
  return resolved.profile && resolved.profile.provider === provider
    ? (resolved as ActiveAgentProfile)
    : NO_PROFILE();
}

/**
 * Inject the always-present funny_watch tool (deferred-wake "snooze") on
 * EVERY spawn. In-process MCP so the handler runs here with the spawn's
 * threadId/userId. Server name `funny` → tool `mcp__funny__funny_watch`,
 * auto-allowed by the `mcp__funny__*` wildcard in sdk-claude.
 */
export async function withWatchMcpServer(
  threadId: string,
  userId: string | undefined,
  mcpServers: Record<string, any> | undefined,
): Promise<Record<string, any> | undefined> {
  if (!userId) return mcpServers;
  const { buildWatchMcpServer } = await import('../agent-watch-tool.js');
  return {
    ...(mcpServers ?? {}),
    funny: buildWatchMcpServer(threadId, userId),
  };
}
