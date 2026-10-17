import type { AgentProvider } from '@funny/shared';

import type { RuntimeThreadRecord } from '../server-interfaces.js';
import { withWatchMcpServer } from './agent-profile.js';
import { loadProjectMcpServers } from './load-mcp-servers.js';
import { resolveAgentTemplate, type AgentTemplateResolution } from './resolve-agent-template.js';

/**
 * Resolve the MCP servers, tool restrictions and template wiring for a spawn:
 * project MCP servers (when none were explicitly provided), the Deep Agent
 * template, then the always-present funny_watch server.
 */
export async function resolveAgentTooling(input: {
  threadId: string;
  thread: RuntimeThreadRecord | undefined;
  /** Undefined for scratch threads — there is no project MCP context. */
  projectPath: string | undefined;
  provider: AgentProvider;
  mcpServers?: Record<string, any>;
  disallowedTools?: string[];
  claudeConfigDir?: string;
}): Promise<AgentTemplateResolution> {
  const { threadId, thread, projectPath, provider } = input;
  let mcpServers = input.mcpServers;
  if (!mcpServers && projectPath) {
    mcpServers = await loadProjectMcpServers(threadId, projectPath, provider, {
      claudeConfigDir: input.claudeConfigDir,
    });
  }

  const template = await resolveAgentTemplate({
    threadId,
    thread,
    provider,
    disallowedTools: input.disallowedTools,
    mcpServers,
  });
  return {
    ...template,
    mcpServers: await withWatchMcpServer(threadId, thread?.userId, template.mcpServers),
  };
}
