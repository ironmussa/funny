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
type ACPMcpServer = import('@agentclientprotocol/sdk').McpServer;

/** Name/value pairs as the internal map writes them: a plain object, or ACP's own pair list. */
type PairSource = Readonly<Record<string, unknown>> | readonly unknown[];

/** One entry of the internal MCP server map; every field is checked before use. */
interface InternalMcpServer {
  type?: unknown;
  command?: unknown;
  args?: unknown;
  url?: unknown;
  env?: PairSource;
  headers?: PairSource;
}

export function toACPMcpServers(mcpServers: Record<string, any> | undefined): ACPMcpServer[] {
  if (!mcpServers) return [];

  const recordToPairs = (rec: PairSource | undefined): Array<{ name: string; value: string }> => {
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
      return Object.entries(rec as Record<string, unknown>).map(([name, value]) => ({
        name,
        value: String(value ?? ''),
      }));
    }
    return [];
  };

  const out: ACPMcpServer[] = [];
  for (const [name, raw] of Object.entries(mcpServers)) {
    if (!raw || !isObject(raw)) continue;
    const cfg: InternalMcpServer = raw;
    const type = (cfg.type as string | undefined)?.toLowerCase();

    // In-process SDK MCP servers (createSdkMcpServer) run inside this process
    // and have no stdio/http transport, so they cannot be handed to a separate
    // ACP provider. Skip them rather than emitting a broken `command: ''`
    // stdio entry. funny's own servers are HTTP, so they pass through.
    if (type === 'sdk') continue;

    if (type === 'http' || type === 'sse') {
      out.push({
        type,
        name,
        url: String(cfg.url ?? ''),
        headers: recordToPairs(cfg.headers),
      } as ACPMcpServer);
    } else {
      out.push({
        name,
        command: String(cfg.command ?? ''),
        args: Array.isArray(cfg.args) ? (cfg.args as string[]).map(String) : [],
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
