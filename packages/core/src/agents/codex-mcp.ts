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
 *
 * Codex also stops an MCP tool call after 60 s by default. funny's own
 * loopback servers (`agent-mcp-http.ts`) have tools that run longer (a
 * synchronous `funny_run_checks` ≤ 30 min), so they get `FUNNY_TOOL_TIMEOUT_SEC`.
 */

export interface CodexMcpConfig {
  /** Value for Codex `mcp_servers`. */
  mcpServers: Record<
    string,
    {
      url: string;
      bearer_token_env_var?: string;
      default_tools_approval_mode?: 'approve';
      tool_timeout_sec?: number;
    }
  >;
  /** Variables the Codex process needs (bearer tokens). */
  env: Record<string, string>;
}

/** Codex tool timeout for funny's servers: a synchronous check's 30 min, plus margin. */
export const FUNNY_TOOL_TIMEOUT_SEC = 31 * 60;

/** funny's agent MCP servers listen on loopback at `/mcp/<name>`. */
const isFunnyServer = (url: string) => /^http:\/\/127\.0\.0\.1:\d+\/mcp\/[\w-]+$/.test(url);

function tokenEnvVar(name: string): string {
  return `FUNNY_MCP_TOKEN_${name.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}`;
}

type CodexEntry = CodexMcpConfig['mcpServers'][string];

/** The bearer token in an entry's `Authorization` header, if any. */
function bearerToken(headers: unknown): string | undefined {
  const authorization = Object.entries((headers ?? {}) as Record<string, unknown>).find(
    ([key]) => key.toLowerCase() === 'authorization',
  )?.[1];
  return /^Bearer\s+(\S+)$/i.exec(String(authorization ?? ''))?.[1];
}

/** One streamable-HTTP server as a Codex entry, its token moved to `env`; null for others. */
function codexEntry(
  name: string,
  raw: unknown,
  extra: Partial<CodexEntry>,
  env: Record<string, string>,
): CodexEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const { type, url, headers } = raw as { type?: unknown; url?: unknown; headers?: unknown };
  if (String(type ?? '').toLowerCase() !== 'http' || typeof url !== 'string') return null;
  const timeout = isFunnyServer(url) ? { tool_timeout_sec: FUNNY_TOOL_TIMEOUT_SEC } : {};
  const token = bearerToken(headers);
  if (!token) return { url, ...extra, ...timeout };
  const envVar = tokenEnvVar(name);
  env[envVar] = token;
  return { url, bearer_token_env_var: envVar, ...extra, ...timeout };
}

export function toCodexMcpConfig(
  mcpServers: Record<string, any> | undefined,
  options: { approveTools?: boolean } = {},
): CodexMcpConfig {
  const config: CodexMcpConfig = { mcpServers: {}, env: {} };
  const approval = options.approveTools ? { default_tools_approval_mode: 'approve' as const } : {};
  for (const [name, raw] of Object.entries(mcpServers ?? {})) {
    const entry = codexEntry(name, raw, approval, config.env);
    if (entry) config.mcpServers[name] = entry;
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
