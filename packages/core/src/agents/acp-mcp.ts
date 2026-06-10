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

export function toACPMcpServers(mcpServers: Record<string, any> | undefined): ACPMcpServer[] {
  if (!mcpServers) return [];

  const recordToPairs = (rec: unknown): Array<{ name: string; value: string }> => {
    if (!rec) return [];
    if (Array.isArray(rec)) {
      return rec
        .filter(
          (e): e is { name: string; value: string } =>
            !!e && typeof e === 'object' && 'name' in e && 'value' in e,
        )
        .map((e) => ({ name: String(e.name), value: String(e.value) }));
    }
    if (typeof rec === 'object') {
      return Object.entries(rec as Record<string, unknown>).map(([name, value]) => ({
        name,
        value: String(value ?? ''),
      }));
    }
    return [];
  };

  // Built loosely (the ACP schema's discriminated union is awkward to satisfy
  // field-by-field); each entry matches one of McpServerStdio/Http/Sse exactly,
  // validated by opencode/cursor/codex/gemini/pi at runtime. Cast at the return
  // boundary so callers get the precise `McpServer[]` type.
  const out: Array<Record<string, unknown>> = [];
  for (const [name, raw] of Object.entries(mcpServers)) {
    if (!raw || typeof raw !== 'object') continue;
    const cfg = raw as Record<string, unknown>;
    const type = (cfg.type as string | undefined)?.toLowerCase();

    // In-process SDK MCP servers (createSdkMcpServer, e.g. funny_watch) run
    // inside this process and have no stdio/http transport, so they cannot be
    // handed to a separate ACP provider. Skip them rather than emitting a
    // broken `command: ''` stdio entry. (External-MCP funny_watch for ACP
    // providers is a follow-up.)
    if (type === 'sdk') continue;

    if (type === 'http' || type === 'sse') {
      out.push({
        type,
        name,
        url: String(cfg.url ?? ''),
        headers: recordToPairs(cfg.headers),
      });
    } else {
      out.push({
        name,
        command: String(cfg.command ?? ''),
        args: Array.isArray(cfg.args) ? (cfg.args as unknown[]).map(String) : [],
        env: recordToPairs(cfg.env),
      });
    }
  }
  return out as unknown as ACPMcpServer[];
}
