/**
 * Convert the internal Claude-shaped MCP server map into the ACP
 * `McpServer[]` shape required by `session/new` / `session/load`.
 *
 * Internal shape (from agent-lifecycle / Claude SDK):
 *   { [name]: { type?: 'stdio'|'http'|'sse', command?, args?, url?,
 *               env?: Record<string,string>, headers?: Record<string,string> } }
 *
 * ACP shape (per @agentclientprotocol/sdk schema):
 *   stdio: { name, command, args, env: {name,value}[] }
 *   http:  { type:'http', name, url, headers: {name,value}[] }
 *   sse:   { type:'sse',  name, url, headers: {name,value}[] }
 *
 * Strict ACP zod validation rejects entries with missing `name` (dict key
 * gets dropped by `Object.values`) and treats `args`/`env`/`headers` as
 * required, so we always include them with sane defaults.
 */
import type { McpServerMap, McpStringPairs } from './mcp-server-map.js';

type ACPMcpServer = import('@agentclientprotocol/sdk').McpServer;

export function toACPMcpServers(mcpServers: McpServerMap | undefined): ACPMcpServer[] {
  if (!mcpServers) return [];

  const recordToPairs = (
    rec: McpStringPairs | undefined,
  ): Array<{ name: string; value: string }> => {
    if (!rec) return [];
    if (Array.isArray(rec)) {
      return rec
        .filter(
          (e): e is { name: string; value: string } =>
            !!e && typeof e === 'object' && 'name' in e && 'value' in e,
        )
        .map((e) => ({ name: String(e.name), value: String(e.value) }));
    }
    if (isObject(rec)) {
      return Object.entries(rec).map(([name, value]) => ({
        name,
        value: String(value ?? ''),
      }));
    }
    return [];
  };

  const out: ACPMcpServer[] = [];
  for (const [name, cfg] of Object.entries(mcpServers)) {
    if (!cfg || !isObject(cfg)) continue;
    const type = cfg.type?.toLowerCase();

    // In-process SDK MCP servers (createSdkMcpServer) run inside this process
    // and have no stdio/http transport, so they cannot be handed to a separate
    // ACP provider. Skip them rather than emitting a broken `command: ''`
    // stdio entry. funny's own servers are HTTP, so they pass through.
    if (type === 'sdk') continue;

    if (type === 'http' || type === 'sse') {
      // SAFETY: `type` is exactly 'http' or 'sse' in this branch, and `name`, `url`
      // and `headers` are always set, which is the ACP http / sse server shape.
      out.push({
        type,
        name,
        url: String(cfg.url ?? ''),
        headers: recordToPairs(cfg.headers),
      } as ACPMcpServer);
    } else {
      // SAFETY: the object carries every field of the ACP stdio server shape
      // (`name`, `command`, `args`, `env`); `args` is checked to be an array and each
      // element is coerced with `String`.
      out.push({
        name,
        command: String(cfg.command ?? ''),
        args: Array.isArray(cfg.args) ? cfg.args.map(String) : [],
        env: recordToPairs(cfg.env),
      } as ACPMcpServer);
    }
  }
  return out;
}

/** `typeof value === 'object'` without null; keeps `any` as `any`. */
function isObject<T>(value: T): value is T & object {
  return typeof value === 'object' && value !== null;
}
