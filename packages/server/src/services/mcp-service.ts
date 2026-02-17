/**
 * MCP Service — manages MCP servers via the Claude CLI.
 * Uses `claude mcp list/add/remove` commands.
 */

import { ResultAsync } from 'neverthrow';
import { getClaudeBinaryPath } from '../utils/claude-binary.js';
import { execute, ProcessExecutionError } from '@funny/core/git';
import { processError, internal, type DomainError } from '@funny/shared/errors';
import type { McpServer, McpServerType } from '@funny/shared';

/**
 * List MCP servers configured for a project.
 * Returns empty array on failure (best-effort).
 */
export function listMcpServers(projectPath: string): ResultAsync<McpServer[], DomainError> {
  const binary = getClaudeBinaryPath();

  return ResultAsync.fromPromise(
    (async () => {
      try {
        const result = await execute(binary, ['mcp', 'list'], {
          cwd: projectPath,
          reject: false,
          timeout: 15_000,
        });

        const output = result.stdout.trim();

        if (!output || output.includes('No MCP servers configured')) {
          return [];
        }

        return parseMcpListOutput(output);
      } catch (err) {
        console.error('[mcp-service] Failed to list MCP servers:', err);
        return [];
      }
    })(),
    (error) => internal(String(error))
  );
}

/**
 * Parse the text output of `claude mcp list`.
 *
 * Handles two formats from `claude mcp list`:
 *   name: url (HTTP|SSE) - status       → HTTP/SSE server with explicit type
 *   name: command args - status          → stdio server (no type in parens)
 */
function parseMcpListOutput(output: string): McpServer[] {
  const servers: McpServer[] = [];
  const lines = output.split('\n').filter((l) => l.trim());

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('─') || trimmed.startsWith('Name') || trimmed.startsWith('Checking')) continue;

    // Match lines WITH explicit type: "name: value (HTTP|SSE|stdio) - status"
    const typedMatch = trimmed.match(/^(\S+):\s+(.+?)\s+\((HTTP|http|SSE|sse|stdio|STDIO)\)(?:\s*-\s*(.+))?/);
    if (typedMatch) {
      const name = typedMatch[1];
      const value = typedMatch[2].trim();
      const type = typedMatch[3].toLowerCase() as McpServerType;
      const statusText = typedMatch[4]?.trim().toLowerCase() || '';

      const server: McpServer = { name, type };

      if (type === 'http' || type === 'sse') {
        server.url = value;
      } else if (type === 'stdio') {
        const cmdParts = value.split(/\s+/);
        server.command = cmdParts[0];
        server.args = cmdParts.slice(1);
      }

      applyStatus(server, statusText);
      servers.push(server);
      continue;
    }

    // Match lines WITHOUT explicit type: "name: command args - status"
    // These are stdio servers (the CLI omits the type for stdio)
    const untypedMatch = trimmed.match(/^(\S+):\s+(.+?)(?:\s+-\s+(.+))?$/);
    if (untypedMatch) {
      const name = untypedMatch[1];
      const value = untypedMatch[2].trim();
      const statusText = untypedMatch[3]?.trim().toLowerCase() || '';

      const server: McpServer = { name, type: 'stdio' };
      const cmdParts = value.split(/\s+/);
      server.command = cmdParts[0];
      server.args = cmdParts.slice(1);

      applyStatus(server, statusText);
      servers.push(server);
      continue;
    }

    // Fallback: tab/multi-space separated columns
    const parts = trimmed.split(/\s{2,}/);
    if (parts.length >= 2) {
      const name = parts[0].trim();
      const type = (parts[1]?.trim() || 'stdio') as McpServerType;

      const server: McpServer = { name, type };

      if (type === 'http' || type === 'sse') {
        server.url = parts[2]?.trim();
      } else if (type === 'stdio') {
        const cmdStr = parts[2]?.trim();
        if (cmdStr) {
          const cmdParts = cmdStr.split(/\s+/);
          server.command = cmdParts[0];
          server.args = cmdParts.slice(1);
        }
      }

      servers.push(server);
    }
  }

  return servers;
}

function applyStatus(server: McpServer, statusText: string): void {
  if (!statusText) return;
  if (statusText.includes('needs auth') || statusText.includes('authentication')) {
    server.status = 'needs_auth';
  } else if (statusText.includes('error') || statusText.includes('failed')) {
    server.status = 'error';
  } else {
    server.status = 'ok';
  }
}

/**
 * Add an MCP server using the Claude CLI.
 */
export function addMcpServer(opts: {
  name: string;
  type: McpServerType;
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
  scope?: 'project' | 'user';
  projectPath: string;
}): ResultAsync<void, DomainError> {
  const binary = getClaudeBinaryPath();
  const cliArgs: string[] = ['mcp', 'add'];

  cliArgs.push('--transport', opts.type);

  if (opts.scope) {
    cliArgs.push('--scope', opts.scope);
  }

  if (opts.env) {
    for (const [key, value] of Object.entries(opts.env)) {
      cliArgs.push('--env', `${key}=${value}`);
    }
  }

  if (opts.headers) {
    for (const [key, value] of Object.entries(opts.headers)) {
      cliArgs.push('--header', `${key}: ${value}`);
    }
  }

  cliArgs.push(opts.name);

  if (opts.type === 'http' || opts.type === 'sse') {
    if (opts.url) {
      cliArgs.push(opts.url);
    }
  } else if (opts.type === 'stdio') {
    cliArgs.push('--');
    if (opts.command) {
      cliArgs.push(opts.command);
    }
    if (opts.args) {
      cliArgs.push(...opts.args);
    }
  }

  console.log(`[mcp-service] Adding server: ${binary} ${cliArgs.join(' ')}`);

  return ResultAsync.fromPromise(
    execute(binary, cliArgs, { cwd: opts.projectPath, timeout: 30_000 }).then(() => undefined),
    (error) => {
      if (error instanceof ProcessExecutionError) {
        return processError(error.message, error.exitCode, error.stderr);
      }
      return internal(String(error));
    }
  );
}

/**
 * Remove an MCP server using the Claude CLI.
 */
export function removeMcpServer(opts: {
  name: string;
  projectPath: string;
  scope?: 'project' | 'user';
}): ResultAsync<void, DomainError> {
  const binary = getClaudeBinaryPath();
  const cliArgs: string[] = ['mcp', 'remove'];

  if (opts.scope) {
    cliArgs.push('--scope', opts.scope);
  }

  cliArgs.push(opts.name);

  console.log(`[mcp-service] Removing server: ${binary} ${cliArgs.join(' ')}`);

  return ResultAsync.fromPromise(
    execute(binary, cliArgs, { cwd: opts.projectPath, timeout: 15_000 }).then(() => undefined),
    (error) => {
      if (error instanceof ProcessExecutionError) {
        return processError(error.message, error.exitCode, error.stderr);
      }
      return internal(String(error));
    }
  );
}

/**
 * Recommended MCP servers list.
 */
export const RECOMMENDED_SERVERS = [
  {
    name: 'github',
    description: 'GitHub repos, PRs, issues, and code reviews',
    type: 'http' as McpServerType,
    url: 'https://api.githubcopilot.com/mcp/',
  },
  {
    name: 'filesystem',
    description: 'Secure file system operations with configurable access',
    type: 'stdio' as McpServerType,
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem'],
  },
  {
    name: 'fetch',
    description: 'Fetch and process web content from URLs',
    type: 'stdio' as McpServerType,
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-fetch'],
  },
  {
    name: 'memory',
    description: 'Persistent knowledge graph for long-term memory',
    type: 'stdio' as McpServerType,
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-memory'],
  },
  {
    name: 'postgres',
    description: 'Query and manage PostgreSQL databases',
    type: 'stdio' as McpServerType,
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-postgres'],
  },
  {
    name: 'sequential-thinking',
    description: 'Dynamic problem solving with step-by-step reasoning',
    type: 'stdio' as McpServerType,
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
  },
  {
    name: 'playwright',
    description: 'Browser automation and testing with Playwright',
    type: 'stdio' as McpServerType,
    command: 'npx',
    args: ['-y', '@playwright/mcp@latest'],
  },
  {
    name: 'sentry',
    description: 'Error monitoring and debugging via Sentry',
    type: 'http' as McpServerType,
    url: 'https://mcp.sentry.dev/sse',
  },
  {
    name: 'slack',
    description: 'Team communication and Slack workspace access',
    type: 'stdio' as McpServerType,
    command: 'npx',
    args: ['-y', '@anthropic/mcp-server-slack'],
  },
  {
    name: 'brave-search',
    description: 'Web search powered by Brave Search API',
    type: 'stdio' as McpServerType,
    command: 'npx',
    args: ['-y', '@anthropic/mcp-server-brave-search'],
  },
];
