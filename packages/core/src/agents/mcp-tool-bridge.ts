/**
 * MCP tools for agents whose loop funny drives itself (LLM API, pi), which
 * have no MCP client of their own.
 *
 * Connects to the streamable-HTTP entries of the internal MCP map (funny's
 * own servers, see runtime `agent-mcp-http.ts`, plus any other HTTP server)
 * and exposes each tool as a plain function the provider adapts to its own
 * tool format. Tool names follow the MCP convention every other agent uses —
 * `mcp__<server>__<tool>` — so tool cards and permissions read the same.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { createDebugLogger } from '../debug.js';

const dlog = createDebugLogger('mcp-tool-bridge');

/** How long a server may take to connect and list its tools. */
const CONNECT_TIMEOUT_MS = 10_000;

export interface BridgedMcpTool {
  /** `mcp__<server>__<tool>` */
  name: string;
  description: string;
  /** JSON Schema of the arguments, as the server published it. */
  inputSchema: Record<string, unknown>;
  call(args: Record<string, unknown>, signal?: AbortSignal): Promise<BridgedMcpResult>;
}

export interface BridgedMcpResult {
  text: string;
  isError: boolean;
}

export interface McpToolBridge {
  tools: BridgedMcpTool[];
  /** Server instructions, for the system prompt. */
  instructions: Array<{ server: string; text: string }>;
  close(): Promise<void>;
}

interface McpContentPart {
  type: string;
  text?: string;
  mimeType?: string;
}

/** Flatten an MCP tool result to text (these agents take text tool results). */
function mcpResultText(content: McpContentPart[] | undefined): string {
  return (content ?? [])
    .map((part) =>
      part.type === 'text'
        ? (part.text ?? '')
        : `[${part.type}${part.mimeType ? ` ${part.mimeType}` : ''}]`,
    )
    .filter(Boolean)
    .join('\n');
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function connectServer(
  server: string,
  url: string,
  headers: Record<string, string>,
): Promise<{ client: Client; tools: BridgedMcpTool[]; instructions?: string }> {
  const client = new Client({ name: 'funny', version: '1.0.0' });
  await withTimeout(
    client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } })),
    CONNECT_TIMEOUT_MS,
    `MCP server ${server}`,
  );
  const { tools } = await withTimeout(client.listTools(), CONNECT_TIMEOUT_MS, `${server} tools`);
  return {
    client,
    instructions: client.getInstructions(),
    tools: tools.map((tool) => ({
      name: `mcp__${server}__${tool.name}`,
      description: tool.description ?? '',
      inputSchema: (tool.inputSchema ?? { type: 'object' }) as Record<string, unknown>,
      call: async (args, signal) => {
        const result = await client.callTool({ name: tool.name, arguments: args }, undefined, {
          signal,
          // Tools carry their own bounds (browser actions ≤ 30 s).
          timeout: 5 * 60_000,
        });
        return {
          text: mcpResultText(result.content as McpContentPart[] | undefined),
          isError: result.isError === true,
        };
      },
    })),
  };
}

/**
 * Connect to every streamable-HTTP server in the internal MCP map. A server
 * that fails to connect is skipped (logged), so one broken server never
 * blocks the agent.
 */
export async function connectMcpTools(
  mcpServers: Record<string, any> | undefined,
): Promise<McpToolBridge> {
  const entries = Object.entries(mcpServers ?? {}).filter(
    ([, cfg]) =>
      cfg &&
      typeof cfg === 'object' &&
      String(cfg.type ?? '').toLowerCase() === 'http' &&
      typeof cfg.url === 'string',
  );
  const connected = await Promise.all(
    entries.map(([server, cfg]) =>
      connectServer(server, cfg.url, (cfg.headers ?? {}) as Record<string, string>).catch(
        (err: unknown) => {
          dlog.warn(`skipping MCP server ${server}: ${err instanceof Error ? err.message : err}`);
          return null;
        },
      ),
    ),
  );
  const servers = connected.flatMap((c, i) => (c ? [{ server: entries[i][0], ...c }] : []));
  return {
    tools: servers.flatMap((s) => s.tools),
    instructions: servers.flatMap((s) =>
      s.instructions ? [{ server: s.server, text: s.instructions }] : [],
    ),
    close: async () => {
      await Promise.all(servers.map((s) => s.client.close().catch(() => {})));
    },
  };
}

/** System-prompt section with the servers' instructions ('' when none). */
export function mcpInstructionsBlock(instructions: McpToolBridge['instructions']): string {
  if (instructions.length === 0) return '';
  return [
    '## Tool server instructions',
    ...instructions.map((i) => `### ${i.server}\n${i.text}`),
  ].join('\n\n');
}
