import { resolve } from 'node:path';

import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import { getProviderResourceDescriptor, type AgentProvider, type McpServer } from '@funny/shared';

import { log } from '../../lib/logger.js';
import { listConfiguredClaudeMcpServers, listMcpServers } from '../mcp-service.js';

/** The fields of a configured server that are injected into an agent's `mcpServers` map. */
export type ProjectMcpServerEntry = Pick<McpServer, 'type'> &
  Partial<Pick<McpServer, 'url' | 'command' | 'args' | 'headers' | 'env'>>;

/**
 * One entry of an agent's `mcpServers` map: an SDK server config (funny's own
 * loopback servers), a project server converted by `toSdkEntry`, or a Deep
 * Agent template's stored server (an `McpServer`, which carries its `name`).
 */
export type AgentMcpServerEntry = McpServerConfig | ProjectMcpServerEntry | McpServer;

/** An agent's MCP servers, keyed by server name, as handed to the orchestrator. */
export type AgentMcpServers = Record<string, AgentMcpServerEntry>;

/**
 * Claude.ai connectors (`claude.ai Gmail`, …) are loaded by the Claude CLI
 * itself, authenticated through the user's claude.ai account. Re-sending them
 * as plain `http` servers gives the CLI an unauthenticated duplicate: it marks
 * them failed / needs-auth and holds the session `init` for its 30 s MCP
 * connect timeout, so every thread waited ~30 s before its first event.
 */
function isClaudeAiConnector(name: string): boolean {
  return name.startsWith('claude.ai ') || name.startsWith('claude_ai_');
}

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
 * Claude reads its MCP config itself (`settingSources: ['user', 'project']`),
 * keyed by its working directory. So:
 * - agent in the project directory (local mode): nothing to inject, the CLI
 *   already has every server with the right enabled/disabled state;
 * - agent in a worktree: the CLI would look up `~/.claude.json` under the
 *   worktree path and miss the project's local-scope servers and disabled
 *   list, so they are read from the config files for the project path and
 *   passed explicitly. No `claude mcp list` here: it connects to every server
 *   and cost 2–4 s on every message.
 *
 * Returns undefined when no compatible servers are enabled (caller falls back
 * to its existing `mcpServers` argument).
 */
export async function loadProjectMcpServers(
  threadId: string,
  mcpProjectPath: string,
  provider: AgentProvider,
  options: { claudeConfigDir?: string; cwd?: string } = {},
): Promise<AgentMcpServers | undefined> {
  try {
    const descriptor = getProviderResourceDescriptor(provider);
    if (!descriptor.mcp.supported) return undefined;
    if (claudeLoadsItsOwnConfig(provider, mcpProjectPath, options.cwd)) return undefined;

    const serverListResult = await listServersForAgent(mcpProjectPath, provider, {
      claudeConfigDir: options.claudeConfigDir,
    });
    if (serverListResult.isErr()) {
      log.warn('Failed to list project MCP servers', {
        namespace: 'agent',
        threadId,
        error: String(serverListResult.error),
      });
      return undefined;
    }

    const enabledServers = serverListResult.value.filter((s) =>
      isInjectable(s, descriptor.mcp.transports),
    );
    if (enabledServers.length === 0) return undefined;

    log.info('Loaded project MCP servers', {
      namespace: 'agent',
      threadId,
      count: enabledServers.length,
      names: enabledServers.map((s) => s.name),
      serversWithHeaders: enabledServers
        .filter((s) => s.headers && Object.keys(s.headers).length > 0)
        .map((s) => s.name),
    });

    return Object.fromEntries(enabledServers.map((srv) => [srv.name, toSdkEntry(srv)]));
  } catch (e) {
    log.warn('Error loading project MCP servers', {
      namespace: 'agent',
      threadId,
      error: String(e),
    });
    return undefined;
  }
}

/** Claude running in the project directory already reads the same config. */
function claudeLoadsItsOwnConfig(
  provider: AgentProvider,
  projectPath: string,
  cwd: string | undefined,
): boolean {
  return provider === 'claude' && !!cwd && resolve(cwd) === resolve(projectPath);
}

function listServersForAgent(
  projectPath: string,
  provider: AgentProvider,
  profile: { claudeConfigDir?: string },
) {
  return provider === 'claude'
    ? listConfiguredClaudeMcpServers(projectPath, profile)
    : listMcpServers(projectPath, provider, profile);
}

function isInjectable(server: McpServer, transports: readonly McpServer['type'][]): boolean {
  return (
    !isClaudeAiConnector(server.name) &&
    !server.disabled &&
    server.status !== 'needs_auth' &&
    server.status !== 'error' &&
    transports.includes(server.type)
  );
}

/** The SDK's `mcpServers` record entry for one server. */
function toSdkEntry(srv: McpServer): ProjectMcpServerEntry {
  // Same shape as before: absent fields are omitted, not `undefined`.
  const entry: ProjectMcpServerEntry = { type: srv.type };
  if (srv.type === 'http' || srv.type === 'sse') {
    if (srv.url !== undefined) entry.url = srv.url;
  } else {
    if (srv.command !== undefined) entry.command = srv.command;
    if (srv.args !== undefined) entry.args = srv.args;
  }
  if (srv.headers) entry.headers = srv.headers;
  if (srv.env) entry.env = srv.env;
  return entry;
}
