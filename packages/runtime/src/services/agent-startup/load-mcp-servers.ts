import { getProviderResourceDescriptor, type AgentProvider } from '@funny/shared';

import { log } from '../../lib/logger.js';
import { listMcpServers } from '../mcp-service.js';

/**
 * Loads enabled project MCP servers and converts them to the orchestrator's
 * record-shape. Pulled out of agent-lifecycle so the parent doesn't need to
 * import mcp-service.
 *
 * Servers are filtered by the EFFECTIVE provider's resource descriptor (the
 * same shared source the resolver/composer use), so a provider only ever
 * receives MCP servers whose transport it supports. Claude's descriptor allows
 * all transports, so its behavior is unchanged. The ACP adapter's
 * capability filter remains as a second line of defense.
 *
 * Returns undefined when no compatible servers are enabled (caller falls back
 * to its existing `mcpServers` argument).
 */
export async function loadProjectMcpServers(
  threadId: string,
  mcpProjectPath: string,
  provider: AgentProvider,
  options: { claudeConfigDir?: string } = {},
): Promise<Record<string, any> | undefined> {
  try {
    const descriptor = getProviderResourceDescriptor(provider);
    if (!descriptor.mcp.supported) return undefined;

    const serverListResult = await listMcpServers(mcpProjectPath, provider, options);
    if (serverListResult.isErr()) {
      log.warn('Failed to list project MCP servers', {
        namespace: 'agent',
        threadId,
        error: String(serverListResult.error),
      });
      return undefined;
    }

    const enabledServers = serverListResult.value.filter(
      (s) =>
        !s.disabled &&
        s.status !== 'needs_auth' &&
        s.status !== 'error' &&
        descriptor.mcp.transports.includes(s.type),
    );
    if (enabledServers.length === 0) return undefined;

    const mcpServers: Record<string, any> = {};
    for (const srv of enabledServers) {
      const entry: Record<string, any> = { type: srv.type };
      if (srv.type === 'http' || srv.type === 'sse') {
        if (srv.url) entry.url = srv.url;
      } else {
        if (srv.command) entry.command = srv.command;
        if (srv.args) entry.args = srv.args;
      }
      if (srv.headers) entry.headers = srv.headers;
      if (srv.env) entry.env = srv.env;
      mcpServers[srv.name] = entry;
    }

    log.info('Loaded project MCP servers', {
      namespace: 'agent',
      threadId,
      count: enabledServers.length,
      names: enabledServers.map((s) => s.name),
      serversWithHeaders: enabledServers
        .filter((s) => s.headers && Object.keys(s.headers).length > 0)
        .map((s) => s.name),
    });

    return mcpServers;
  } catch (e) {
    log.warn('Error loading project MCP servers', {
      namespace: 'agent',
      threadId,
      error: String(e),
    });
    return undefined;
  }
}
