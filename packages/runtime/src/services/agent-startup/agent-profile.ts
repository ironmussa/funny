import type { AgentProvider } from '@funny/shared';

import { claudeProfileEnv } from '../../utils/claude-profile-paths.js';
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
  if (!resolved.profile || resolved.profile.provider !== provider) return NO_PROFILE();

  // Resolve home-relative paths on the runner that launches the agent, not
  // on the server that stores the profile.
  return {
    ...resolved,
    env: {
      ...resolved.env,
      ...claudeProfileEnv(resolved.env.CLAUDE_CONFIG_DIR),
    },
  };
}

/**
 * Inject the always-present `funny` server (watchers, background jobs,
 * sub-threads, thread search) on EVERY spawn, whatever the
 * agent: loopback HTTP with the thread's token, so the handlers run in the
 * runner with the spawn's threadId/userId. Tool `mcp__funny__funny_watch`,
 * auto-allowed by the `mcp__funny__*` wildcard in sdk-claude.
 */
export async function withWatchMcpServer(
  threadId: string,
  userId: string | undefined,
  mcpServers: Record<string, any> | undefined,
  provider?: AgentProvider,
): Promise<Record<string, any> | undefined> {
  if (!userId) return mcpServers;
  const { FUNNY_MCP_SERVER } = await import('../agent-watch-tool.js');
  const { grantAgentMcpHttp } = await import('../agent-mcp-http.js');
  return {
    ...(mcpServers ?? {}),
    [FUNNY_MCP_SERVER.name]: grantAgentMcpHttp(FUNNY_MCP_SERVER, {
      threadId,
      userId,
      // Claude tracks native tasks through completion after the main turn.
      // Keep the fallback for adapters without verified lifecycle support.
      nativeBackgroundJobs: provider === 'claude',
    }),
  };
}

/**
 * Inject the `funny_browser` server (agent browser tools over the thread's
 * browser session). Every agent gets the same loopback HTTP server, whatever
 * its provider. Kill switch: `FUNNY_BROWSER_TOOLS=0`.
 */
export async function withBrowserMcpServer(
  threadId: string,
  userId: string | undefined,
  mcpServers: Record<string, any> | undefined,
  cwd?: string,
): Promise<Record<string, any> | undefined> {
  if (!userId || process.env.FUNNY_BROWSER_TOOLS === '0') return mcpServers;
  const { BROWSER_MCP_SERVER } = await import('../browser-automation/browser-mcp-server.js');
  const { grantAgentMcpHttp } = await import('../agent-mcp-http.js');
  const { tmpAssetsPathFor } = await import('../thread-context.js');
  return {
    ...(mcpServers ?? {}),
    [BROWSER_MCP_SERVER.name]: grantAgentMcpHttp(BROWSER_MCP_SERVER, {
      threadId,
      userId,
      cwd,
      assetsDir: tmpAssetsPathFor(userId),
    }),
  };
}
