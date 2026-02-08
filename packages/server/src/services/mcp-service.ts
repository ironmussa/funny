/**
 * MCP Service — manages MCP servers via the Claude CLI.
 * Uses `claude mcp list/add/remove` commands.
 */

import { getClaudeBinaryPath } from '../utils/claude-binary.js';
import { execute } from '../utils/process.js';
import type { McpServer, McpServerType } from '@a-parallel/shared';

/**
 * List MCP servers configured for a project.
 * Parses the output of `claude mcp list` (text format).
 */
export async function listMcpServers(projectPath: string): Promise<McpServer[]> {
  const binary = getClaudeBinaryPath();

  try {
    const result = await execute(binary, ['mcp', 'list'], {
      cwd: projectPath,
      reject: false,
      timeout: 15_000,
    });

    const output = result.stdout.trim();

    // "No MCP servers configured" means empty
    if (!output || output.includes('No MCP servers configured')) {
      return [];
    }

    return parseMcpListOutput(output);
  } catch (err) {
    console.error('[mcp-service] Failed to list MCP servers:', err);
    return [];
  }
}

/**
 * Parse the text output of `claude mcp list`.
 * Format is typically:
 *   - server-name: type(command/url) [scope]
 * or a table/structured text format.
 */
function parseMcpListOutput(output: string): McpServer[] {
  const servers: McpServer[] = [];
  const lines = output.split('\n').filter((l) => l.trim());

  for (const line of lines) {
    // Try to parse lines like: "  server-name  stdio  npx -y @package  local"
    // or "  server-name  http  https://url  user"
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('─') || trimmed.startsWith('Name')) continue;

    // Split by multiple spaces (table format)
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

/**
 * Add an MCP server using the Claude CLI.
 */
export async function addMcpServer(opts: {
  name: string;
  type: McpServerType;
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
  scope?: 'project' | 'user';
  projectPath: string;
}): Promise<void> {
  const binary = getClaudeBinaryPath();
  const cliArgs: string[] = ['mcp', 'add'];

  // Transport type
  cliArgs.push('--transport', opts.type);

  // Scope
  if (opts.scope) {
    cliArgs.push('--scope', opts.scope);
  }

  // Environment variables
  if (opts.env) {
    for (const [key, value] of Object.entries(opts.env)) {
      cliArgs.push('--env', `${key}=${value}`);
    }
  }

  // Headers (for http)
  if (opts.headers) {
    for (const [key, value] of Object.entries(opts.headers)) {
      cliArgs.push('--header', `${key}: ${value}`);
    }
  }

  // Server name
  cliArgs.push(opts.name);

  if (opts.type === 'http' || opts.type === 'sse') {
    // URL follows the name
    if (opts.url) {
      cliArgs.push(opts.url);
    }
  } else if (opts.type === 'stdio') {
    // Command and args after --
    cliArgs.push('--');
    if (opts.command) {
      cliArgs.push(opts.command);
    }
    if (opts.args) {
      cliArgs.push(...opts.args);
    }
  }

  console.log(`[mcp-service] Adding server: ${binary} ${cliArgs.join(' ')}`);

  await execute(binary, cliArgs, {
    cwd: opts.projectPath,
    timeout: 30_000,
  });
}

/**
 * Remove an MCP server using the Claude CLI.
 */
export async function removeMcpServer(opts: {
  name: string;
  projectPath: string;
  scope?: 'project' | 'user';
}): Promise<void> {
  const binary = getClaudeBinaryPath();
  const cliArgs: string[] = ['mcp', 'remove'];

  if (opts.scope) {
    cliArgs.push('--scope', opts.scope);
  }

  cliArgs.push(opts.name);

  console.log(`[mcp-service] Removing server: ${binary} ${cliArgs.join(' ')}`);

  await execute(binary, cliArgs, {
    cwd: opts.projectPath,
    timeout: 15_000,
  });
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
