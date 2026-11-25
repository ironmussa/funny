/**
 * The internal (Claude-shaped) MCP server map runtime hands an agent, as the
 * converters for other agents (ACP, Codex, the tool bridge) read it.
 */

/** `env` / `headers` of an entry: a name → value map, or ACP-style `{ name, value }` pairs. */
export type McpStringPairs =
  | Readonly<Record<string, string>>
  | ReadonlyArray<{ name: string; value: string }>;

/**
 * One server: stdio (`command`), `http` / `sse` (`url`), or an in-process SDK
 * server (`type: 'sdk'`). Every field is optional: the converters skip or
 * default what an entry lacks.
 */
export interface McpServerEntry {
  type?: string;
  command?: string;
  args?: readonly string[];
  url?: string;
  env?: McpStringPairs;
  headers?: McpStringPairs;
  /** The server object of an in-process `type: 'sdk'` entry. */
  instance?: object;
}

/** Server name → entry. */
export type McpServerMap = Readonly<Record<string, McpServerEntry>>;
