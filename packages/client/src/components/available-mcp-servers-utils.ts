import type { McpServer } from '@funny/shared';

/** Enabled servers the agent can actually use (matches user-facing "active" toggle). */
export function isActiveMcpServer(server: McpServer): boolean {
  if (server.disabled) return false;
  if (server.status === 'needs_auth' || server.status === 'error') return false;
  return true;
}

/** Enabled servers worth showing in the composer, including auth-blocked ones. */
export function isVisibleMcpServer(server: McpServer): boolean {
  if (server.disabled) return false;
  if (server.status === 'error') return false;
  return true;
}
