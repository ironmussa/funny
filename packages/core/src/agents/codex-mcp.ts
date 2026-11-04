/**
 * Convert the internal (Claude-shaped) MCP server map into Codex config.
 *
 * Only streamable-HTTP entries (`{ type: 'http', url, headers }`) are passed
 * on: in-process SDK servers cannot cross the process boundary, and stdio
 * servers stay out of scope until a caller needs them. A bearer token in
 * `headers.Authorization` travels through the child environment
 * (`bearer_token_env_var`), never through `--config` arguments, which other
 * local users could read from the process list.
 *
 * Codex asks for approval before MCP tool calls, and its SDK mode cannot ask
 * anyone, so calls fail ("requires approval") unless the server's tools are
 * pre-approved (`approveTools`).
 */

export interface CodexMcpConfig {
  /** Value for Codex `mcp_servers`. */
  mcpServers: Record<
    string,
    { url: string; bearer_token_env_var?: string; default_tools_approval_mode?: 'approve' }
  >;
  /** Variables the Codex process needs (bearer tokens). */
  env: Record<string, string>;
}

function tokenEnvVar(name: string): string {
  return `FUNNY_MCP_TOKEN_${name.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}`;
}

export function toCodexMcpConfig(
  mcpServers: Record<string, any> | undefined,
  options: { approveTools?: boolean } = {},
): CodexMcpConfig {
  const config: CodexMcpConfig = { mcpServers: {}, env: {} };
  const approval = options.approveTools ? { default_tools_approval_mode: 'approve' as const } : {};
  for (const [name, raw] of Object.entries(mcpServers ?? {})) {
    if (!raw || typeof raw !== 'object') continue;
    if (String(raw.type ?? '').toLowerCase() !== 'http' || typeof raw.url !== 'string') continue;
    const headers = (raw.headers ?? {}) as Record<string, unknown>;
    const authorization = Object.entries(headers).find(
      ([key]) => key.toLowerCase() === 'authorization',
    )?.[1];
    const token = /^Bearer\s+(\S+)$/i.exec(String(authorization ?? ''))?.[1];
    if (token) {
      const envVar = tokenEnvVar(name);
      config.env[envVar] = token;
      config.mcpServers[name] = { url: raw.url, bearer_token_env_var: envVar, ...approval };
    } else {
      config.mcpServers[name] = { url: raw.url, ...approval };
    }
  }
  return config;
}

/**
 * Codex settings for a spawn: the `mcp_servers` config entry (omitted when
 * there are none) and the env carrying the tokens. Tools are pre-approved
 * except in read-only plan mode.
 */
export function codexMcpSettings(
  mcpServers: Record<string, any> | undefined,
  permissionMode: string | undefined,
): { config: { mcp_servers?: CodexMcpConfig['mcpServers'] }; env: Record<string, string> } {
  const mcp = toCodexMcpConfig(mcpServers, { approveTools: permissionMode !== 'plan' });
  const hasServers = Object.keys(mcp.mcpServers).length > 0;
  return { config: hasServers ? { mcp_servers: mcp.mcpServers } : {}, env: mcp.env };
}
