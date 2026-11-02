/**
 * @domain subdomain: Agent Tooling
 * @domain subdomain-type: supporting
 * @domain type: adapter
 * @domain layer: infrastructure
 *
 * funny's own MCP servers (`funny`, `funny_browser`) over streamable HTTP, so
 * every agent gets the same tools whatever its provider: Claude, Codex and ACP
 * providers all take an `{ type: 'http', url, headers }` entry, while an
 * in-process SDK server only works for Claude.
 *
 * The listener binds to loopback on an ephemeral port and is separate from
 * the runtime API, so it is never reachable through the server tunnel. Each
 * thread gets one random bearer token, bound to its user and paths, that
 * opens every server at `/mcp/<name>`. The token is stable across spawns of
 * the thread — the orchestrator compares MCP config to decide whether a
 * follow-up can reuse the running agent — and is revoked when the thread is
 * deleted. Requests are stateless: one MCP server per request.
 */

import { randomBytes } from 'crypto';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';

import { log } from '../lib/logger.js';
import { metric } from '../lib/telemetry.js';

const NS = 'agent-mcp-http';

/** What a tool may know about the spawn it serves — from the grant, never the model. */
export interface AgentToolContext {
  threadId: string;
  userId: string;
  cwd?: string;
  assetsDir?: string;
}

export interface AgentToolResult {
  [key: string]: unknown;
  content: Array<
    { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
  >;
  isError?: boolean;
}

/** One tool, independent of the MCP server hosting it. */
export interface AgentToolDefinition {
  name: string;
  description: string;
  /** Zod raw shape of the tool's arguments (`{}` for none). */
  schema: Record<string, any>;
  run: (args: any, extra: unknown) => Promise<AgentToolResult>;
}

/** A funny MCP server: its tools are built per request for the token's thread. */
export interface AgentMcpServerSpec {
  name: string;
  instructions: string;
  /** Claude: always list the tools instead of deferring them behind tool search. */
  alwaysLoad?: boolean;
  tools: (ctx: AgentToolContext) => AgentToolDefinition[];
}

/** token → spawn context; threadId → its token (one per thread). */
const grants = new Map<string, AgentToolContext>();
const tokenByThread = new Map<string, string>();
/** Servers ever granted, by name — what `/mcp/<name>` can serve. */
const servers = new Map<string, AgentMcpServerSpec>();

let listener: ReturnType<typeof Bun.serve> | null = null;

function contextFor(req: Request): AgentToolContext | null {
  const header = req.headers.get('authorization') ?? '';
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  return match ? (grants.get(match[1]) ?? null) : null;
}

async function handle(req: Request): Promise<Response> {
  const name = /^\/mcp\/([\w-]+)$/.exec(new URL(req.url).pathname)?.[1];
  const spec = name ? servers.get(name) : undefined;
  if (!spec) return new Response('Not found', { status: 404 });
  const ctx = contextFor(req);
  if (!ctx) {
    metric('agent_mcp_http.unauthorized', 1, { type: 'sum', attributes: { server: spec.name } });
    return new Response('Unauthorized', { status: 401 });
  }
  const server = new McpServer(
    { name: spec.name, version: '1.0.0' },
    { instructions: spec.instructions },
  );
  for (const def of spec.tools(ctx)) {
    server.registerTool(
      def.name,
      { description: def.description, inputSchema: def.schema },
      (args: unknown, extra: unknown) => def.run(args ?? {}, extra) as any,
    );
  }
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(req);
  } finally {
    void server.close().catch(() => {});
  }
}

function ensureListener(): ReturnType<typeof Bun.serve> {
  listener ??= Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    // Tools are bounded (browser actions ≤ 30 s) but a wait can take a while.
    idleTimeout: 120,
    fetch: (req) =>
      handle(req).catch((err) => {
        log.warn('agent MCP request failed', { namespace: NS, error: String(err) });
        return new Response('Internal error', { status: 500 });
      }),
  });
  return listener;
}

function tokenFor(ctx: AgentToolContext): string {
  let token = tokenByThread.get(ctx.threadId);
  if (!token || grants.get(token)?.userId !== ctx.userId) {
    revokeAgentMcpHttp(ctx.threadId);
    token = randomBytes(32).toString('base64url');
    tokenByThread.set(ctx.threadId, token);
  }
  // Both servers share the token: keep what either granted (paths may change).
  grants.set(token, { ...grants.get(token), ...ctx });
  return token;
}

/**
 * Grant a spawn access to one funny MCP server. Returns its entry in the
 * internal (Claude-shaped) MCP format.
 */
export function grantAgentMcpHttp(
  spec: AgentMcpServerSpec,
  ctx: AgentToolContext,
): { type: 'http'; url: string; headers: Record<string, string>; alwaysLoad?: true } {
  const port = ensureListener().port;
  servers.set(spec.name, spec);
  return {
    type: 'http',
    url: `http://127.0.0.1:${port}/mcp/${spec.name}`,
    headers: { Authorization: `Bearer ${tokenFor(ctx)}` },
    ...(spec.alwaysLoad ? { alwaysLoad: true as const } : {}),
  };
}

/** Revoke the thread's token (thread deleted). */
export function revokeAgentMcpHttp(threadId: string): void {
  const token = tokenByThread.get(threadId);
  if (!token) return;
  grants.delete(token);
  tokenByThread.delete(threadId);
}

/** Stop the listener and drop every grant (runner shutdown / tests). */
export function stopAgentMcpHttp(): void {
  grants.clear();
  tokenByThread.clear();
  servers.clear();
  listener?.stop(true);
  listener = null;
}
