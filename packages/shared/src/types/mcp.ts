import type { AgentProvider } from '../primitives.js';

// ─── MCP Servers ────────────────────────────────────────

export type McpServerType = 'stdio' | 'http' | 'sse';

export interface McpServer {
  name: string;
  provider?: AgentProvider;
  type: McpServerType;
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
  status?: 'ok' | 'needs_auth' | 'error';
  disabled?: boolean;
  /** Where the server is defined: 'project' (.mcp.json) or 'user' (~/.claude.json) */
  source?: 'user' | 'project';
  /** False for plugin/connector servers that Claude Code manages outside ~/.claude.json */
  toggleable?: boolean;
}

export interface McpListResponse {
  servers: McpServer[];
}

export interface McpAddRequest {
  name: string;
  provider?: AgentProvider;
  type: McpServerType;
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
  scope?: 'project' | 'user';
  projectPath: string;
}

// ─── MCP OAuth ──────────────────────────────────────────

export interface McpOAuthStartRequest {
  serverName: string;
  provider?: AgentProvider;
  projectPath: string;
}

export interface McpOAuthStartResponse {
  authUrl: string;
}

export interface McpRemoveRequest {
  name: string;
  provider?: AgentProvider;
  projectPath: string;
  scope?: 'project' | 'user';
}
