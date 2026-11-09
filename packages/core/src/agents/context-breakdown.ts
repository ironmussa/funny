import type { SDKControlGetContextUsageResponse } from '@anthropic-ai/claude-agent-sdk';
import type { ContextBreakdown } from '@funny/shared';

/**
 * Map the Claude Agent SDK's `getContextUsage()` response to the provider-neutral
 * {@link ContextBreakdown} carried on `agent:context_usage`. Drops render-only
 * data (the CLI's grid and theme colors) and aggregates MCP tools per server so
 * the snapshot stays small enough to persist client-side.
 */
export function toContextBreakdown(
  usage: SDKControlGetContextUsageResponse,
  capturedAt: Date = new Date(),
): ContextBreakdown {
  const servers = new Map<string, { name: string; tools: number; tokens: number }>();
  for (const tool of usage.mcpTools ?? []) {
    const entry = servers.get(tool.serverName) ?? { name: tool.serverName, tools: 0, tokens: 0 };
    entry.tools += 1;
    entry.tokens += tool.tokens;
    servers.set(tool.serverName, entry);
  }

  return {
    model: usage.model,
    totalTokens: usage.totalTokens,
    maxTokens: usage.maxTokens,
    percentage: usage.percentage,
    categories: (usage.categories ?? []).map((c) => ({
      ...(c.id ? { id: c.id } : {}),
      name: c.name,
      tokens: c.tokens,
      kind: c.kind,
    })),
    mcpServers: [...servers.values()].sort((a, b) => b.tokens - a.tokens),
    memoryFiles: (usage.memoryFiles ?? []).map((f) => ({
      path: f.path,
      type: f.type,
      tokens: f.tokens,
    })),
    capturedAt: capturedAt.toISOString(),
  };
}
