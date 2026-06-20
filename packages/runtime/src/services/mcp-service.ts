/**
 * @domain subdomain: Extensions
 * @domain subdomain-type: generic
 * @domain type: app-service
 * @domain layer: application
 * @domain depends: ClaudeBinary
 *
 * Manages MCP servers via the Claude CLI.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { execute, ProcessExecutionError } from '@funny/core/git';
import type { AgentProvider, McpServer, McpServerType } from '@funny/shared';
import { processError, internal, type DomainError } from '@funny/shared/errors';
import { ResultAsync } from 'neverthrow';

import { log } from '../lib/logger.js';
import { getClaudeBinaryPath } from '../utils/claude-binary.js';

function getCodexBinaryPath(): string {
  return process.env.CODEX_BINARY_PATH || process.env.CODEX_BIN || 'codex';
}

/** Shape of per-project settings in ~/.claude.json */
interface ClaudeProjectSettings {
  mcpServers?: Record<string, ClaudeMcpServerEntry>;
  enabledMcpjsonServers?: string[];
  disabledMcpjsonServers?: string[];
  /** Claude CLI's native list for disabled user-scoped servers (per project) */
  disabledMcpServers?: string[];
  [key: string]: unknown;
}

interface ClaudeMcpServerEntry {
  type?: string;
  url?: string;
  command?: string;
  args?: string[];
  headers?: Record<string, string>;
  env?: Record<string, string>;
}

interface ClaudeConfig {
  /** Global user-scoped MCP servers (`claude mcp add` without --scope project) */
  mcpServers?: Record<string, ClaudeMcpServerEntry>;
  /** Global disabled user-scoped MCP servers */
  disabledMcpServers?: string[];
  projects?: Record<string, ClaudeProjectSettings>;
  [key: string]: unknown;
}

/** Plugin and Claude.ai connector servers cannot be toggled via ~/.claude.json */
export function isExternallyManagedMcpServer(name: string): boolean {
  return (
    name.startsWith('plugin:') || name.startsWith('claude_ai_') || name.startsWith('claude.ai')
  );
}

function mergeUserMcpServers(
  config: ClaudeConfig,
  settings: ClaudeProjectSettings,
): Record<string, ClaudeMcpServerEntry> {
  return { ...(config.mcpServers ?? {}), ...(settings.mcpServers ?? {}) };
}

function getDisabledUserMcpNames(
  config: ClaudeConfig,
  settings: ClaudeProjectSettings,
): Set<string> {
  return new Set([...(settings.disabledMcpServers ?? []), ...(config.disabledMcpServers ?? [])]);
}

const CLAUDE_CONFIG_PATH = join(homedir(), '.claude.json');

async function readClaudeConfig(): Promise<ClaudeConfig> {
  try {
    const raw = await readFile(CLAUDE_CONFIG_PATH, 'utf-8');
    return JSON.parse(raw) as ClaudeConfig;
  } catch {
    return {};
  }
}

async function writeClaudeConfig(config: ClaudeConfig): Promise<void> {
  await writeFile(CLAUDE_CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
}

function getProjectSettings(config: ClaudeConfig, projectPath: string): ClaudeProjectSettings {
  const resolved = resolve(projectPath);
  return (config.projects?.[resolved] ?? config.projects?.[projectPath]) || {};
}

function ensureProjectSettings(config: ClaudeConfig, projectPath: string): ClaudeProjectSettings {
  const resolved = resolve(projectPath);
  if (!config.projects) config.projects = {};
  if (!config.projects[resolved]) config.projects[resolved] = {};
  return config.projects[resolved]!;
}

/** Read .mcp.json from the project root */
async function readMcpJson(projectPath: string): Promise<
  Record<
    string,
    {
      type?: string;
      url?: string;
      command?: string;
      args?: string[];
      headers?: Record<string, string>;
      env?: Record<string, string>;
    }
  >
> {
  try {
    const raw = await readFile(join(projectPath, '.mcp.json'), 'utf-8');
    const parsed = JSON.parse(raw);
    return parsed?.mcpServers ?? {};
  } catch {
    return {};
  }
}

/**
 * List MCP servers configured for a project.
 * Merges CLI output with config files to include disabled servers.
 */
export function listMcpServers(
  projectPath: string,
  provider: AgentProvider = 'claude',
): ResultAsync<McpServer[], DomainError> {
  if (provider === 'codex') return listCodexMcpServers(projectPath);
  if (provider !== 'claude') {
    return ResultAsync.fromPromise(Promise.resolve([] as McpServer[]), (error) =>
      internal(String(error)),
    );
  }
  return listClaudeMcpServers(projectPath);
}

function listClaudeMcpServers(projectPath: string): ResultAsync<McpServer[], DomainError> {
  const binary = getClaudeBinaryPath();

  return ResultAsync.fromPromise(
    (async () => {
      try {
        // Get active servers from CLI
        const result = await execute(binary, ['mcp', 'list'], {
          cwd: projectPath,
          reject: false,
          timeout: 15_000,
        });

        const output = result.stdout.trim();
        let activeServers: McpServer[] = [];

        if (output && !output.includes('No MCP servers configured')) {
          activeServers = parseMcpListOutput(output);
        }

        // Read config files to find disabled servers and annotate sources
        const [config, mcpJson] = await Promise.all([readClaudeConfig(), readMcpJson(projectPath)]);

        const settings = getProjectSettings(config, projectPath);
        const disabledProjectNames = new Set(settings.disabledMcpjsonServers ?? []);
        const disabledUserNames = getDisabledUserMcpNames(config, settings);
        const userServers = mergeUserMcpServers(config, settings);
        const activeNames = new Set(activeServers.map((s) => s.name));

        // Annotate active servers with source, disabled state, and config fields
        // (headers/env are not included in CLI text output, so merge from config)
        for (const server of activeServers) {
          server.provider = 'claude';
          if (isExternallyManagedMcpServer(server.name)) {
            server.toggleable = false;
          }
          if (server.name in mcpJson) {
            server.source = 'project';
            if (disabledProjectNames.has(server.name)) server.disabled = true;
            const cfg = mcpJson[server.name];
            if (cfg.headers) server.headers = cfg.headers;
            if (cfg.env) server.env = cfg.env;
          } else if (server.name in userServers) {
            server.source = 'user';
            if (disabledUserNames.has(server.name)) server.disabled = true;
            const cfg = userServers[server.name];
            if (cfg.headers) server.headers = cfg.headers;
            if (cfg.env) server.env = cfg.env;
          }
        }

        // Add disabled .mcp.json servers not in CLI output
        for (const name of disabledProjectNames) {
          if (activeNames.has(name)) continue;
          const cfg = mcpJson[name];
          if (!cfg) continue;
          const type = (cfg.type?.toLowerCase() ?? 'stdio') as McpServerType;
          const server: McpServer = {
            name,
            provider: 'claude',
            type,
            disabled: true,
            source: 'project',
          };
          if (type === 'http' || type === 'sse') {
            server.url = cfg.url;
          } else {
            server.command = cfg.command;
            server.args = cfg.args;
          }
          if (cfg.headers) server.headers = cfg.headers;
          if (cfg.env) server.env = cfg.env;
          activeServers.push(server);
        }

        // Add disabled user-scoped servers not in CLI output
        for (const name of disabledUserNames) {
          if (activeNames.has(name)) continue;
          const cfg = userServers[name];
          if (!cfg) continue;
          const type = (cfg.type?.toLowerCase() ?? 'stdio') as McpServerType;
          const server: McpServer = {
            name,
            provider: 'claude',
            type,
            disabled: true,
            source: 'user',
          };
          if (type === 'http' || type === 'sse') {
            server.url = cfg.url;
          } else {
            server.command = cfg.command;
            server.args = cfg.args;
          }
          if (cfg.headers) server.headers = cfg.headers;
          if (cfg.env) server.env = cfg.env;
          activeServers.push(server);
        }

        return activeServers;
      } catch (e) {
        log.error('Failed to list MCP servers', { namespace: 'mcp-service', error: e });
        return [];
      }
    })(),
    (error) => internal(String(error)),
  );
}

function listCodexMcpServers(projectPath: string): ResultAsync<McpServer[], DomainError> {
  const binary = getCodexBinaryPath();

  return ResultAsync.fromPromise(
    (async () => {
      try {
        const result = await execute(binary, ['mcp', 'list'], {
          cwd: projectPath,
          reject: false,
          timeout: 15_000,
        });

        const output = result.stdout.trim();
        if (!output || output.includes('No MCP servers configured')) return [];

        const summaries = parseCodexMcpListOutput(output);
        const detailed = await Promise.all(
          summaries.map(async (server) => {
            try {
              const getResult = await execute(binary, ['mcp', 'get', server.name], {
                cwd: projectPath,
                reject: false,
                timeout: 15_000,
              });
              if (!getResult.stdout.trim()) return server;
              return { ...server, ...parseCodexMcpGetOutput(server.name, getResult.stdout) };
            } catch {
              return server;
            }
          }),
        );

        return detailed;
      } catch (e) {
        log.error('Failed to list Codex MCP servers', { namespace: 'mcp-service', error: e });
        return [];
      }
    })(),
    (error) => internal(String(error)),
  );
}

function codexTransportToMcpType(transport: string | undefined): McpServerType {
  const normalized = transport?.trim().toLowerCase();
  if (normalized === 'streamable_http' || normalized === 'http') return 'http';
  if (normalized === 'sse') return 'sse';
  return 'stdio';
}

function splitCommand(value: string | undefined): { command?: string; args?: string[] } {
  if (!value) return {};
  const parts = value.split(/\s+/).filter(Boolean);
  return { command: parts[0], args: parts.slice(1) };
}

function parseCodexArgs(value: string | undefined): string[] | undefined {
  if (!value || value === '-') return undefined;
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.map(String);
  } catch {
    // Fall through to whitespace parsing.
  }
  return value.split(/\s+/).filter(Boolean);
}

export function parseCodexMcpListOutput(output: string): McpServer[] {
  const servers: McpServer[] = [];
  const lines = output.split('\n').filter((l) => l.trim());

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('Name ')) continue;

    const parts = trimmed.split(/\s{2,}/).map((p) => p.trim());
    if (parts.length === 0) continue;

    const name = parts[0];
    const statusIndex = parts.findIndex((p) => p === 'enabled' || p === 'disabled');
    const status = statusIndex >= 0 ? parts[statusIndex] : undefined;
    const valueParts = statusIndex >= 0 ? parts.slice(1, statusIndex) : parts.slice(1);
    const url = valueParts.find((p) => /^https?:\/\//.test(p));

    servers.push({
      name,
      provider: 'codex',
      type: url ? 'http' : 'stdio',
      url,
      disabled: status === 'disabled' ? true : undefined,
      status: status === 'enabled' ? 'ok' : undefined,
      source: 'user',
      toggleable: false,
    });
  }

  return servers;
}

export function parseCodexMcpGetOutput(name: string, output: string): McpServer {
  const fields: Record<string, string> = {};
  for (const line of output.split('\n')) {
    const match = line.match(/^\s+([a-zA-Z_][a-zA-Z0-9_]*):\s*(.*)$/);
    if (match) fields[match[1]] = match[2].trim();
  }

  const type = codexTransportToMcpType(fields.transport);
  const server: McpServer = {
    name,
    provider: 'codex',
    type,
    disabled: fields.enabled === 'false' ? true : undefined,
    status: fields.enabled === 'true' ? 'ok' : undefined,
    source: 'user',
    toggleable: false,
  };

  if (type === 'http' || type === 'sse') {
    if (fields.url && fields.url !== '-') server.url = fields.url;
  } else {
    const commandParts = splitCommand(fields.command);
    server.command = commandParts.command;
    server.args = parseCodexArgs(fields.args) ?? commandParts.args;
  }

  return server;
}

/**
 * Toggle an MCP server enabled/disabled.
 * - Project (.mcp.json) servers: toggled via disabledMcpjsonServers in ~/.claude.json
 * - User-scoped servers: toggled via disabledMcpServers in ~/.claude.json (native CLI format)
 */
export function toggleMcpServer(opts: {
  name: string;
  projectPath: string;
  provider?: AgentProvider;
  disabled: boolean;
}): ResultAsync<void, DomainError> {
  if (opts.provider === 'codex') {
    return ResultAsync.fromPromise(
      Promise.reject(new Error('Codex MCP enable/disable is not supported yet')),
      (error) => internal(String(error instanceof Error ? error.message : String(error))),
    );
  }

  return ResultAsync.fromPromise(
    (async () => {
      const config = await readClaudeConfig();
      const settings = ensureProjectSettings(config, opts.projectPath);
      const mcpJson = await readMcpJson(opts.projectPath);

      if (isExternallyManagedMcpServer(opts.name)) {
        throw new Error(
          `Server "${opts.name}" is managed by Claude Code and cannot be toggled here`,
        );
      }

      const userServers = mergeUserMcpServers(config, settings);
      const isProjectServer = opts.name in mcpJson;
      const isUserServer = opts.name in userServers;

      if (!isProjectServer && !isUserServer) {
        throw new Error(`Server "${opts.name}" not found in any config`);
      }

      if (isProjectServer) {
        // Toggle via disabledMcpjsonServers (for .mcp.json servers)
        if (!settings.disabledMcpjsonServers) settings.disabledMcpjsonServers = [];
        if (!settings.enabledMcpjsonServers) settings.enabledMcpjsonServers = [];

        if (opts.disabled) {
          if (!settings.disabledMcpjsonServers.includes(opts.name)) {
            settings.disabledMcpjsonServers.push(opts.name);
          }
          settings.enabledMcpjsonServers = settings.enabledMcpjsonServers.filter(
            (n) => n !== opts.name,
          );
        } else {
          settings.disabledMcpjsonServers = settings.disabledMcpjsonServers.filter(
            (n) => n !== opts.name,
          );
          if (!settings.enabledMcpjsonServers.includes(opts.name)) {
            settings.enabledMcpjsonServers.push(opts.name);
          }
        }
      } else {
        // Toggle via disabledMcpServers (native CLI format for user-scoped servers)
        if (!settings.disabledMcpServers) settings.disabledMcpServers = [];

        if (opts.disabled) {
          if (!settings.disabledMcpServers.includes(opts.name)) {
            settings.disabledMcpServers.push(opts.name);
          }
        } else {
          settings.disabledMcpServers = settings.disabledMcpServers.filter((n) => n !== opts.name);
          // Also clear root-level disables so re-enable works when the server was
          // disabled globally (config.disabledMcpServers) rather than per-project.
          if (config.disabledMcpServers?.includes(opts.name)) {
            config.disabledMcpServers = config.disabledMcpServers.filter((n) => n !== opts.name);
          }
        }
      }

      await writeClaudeConfig(config);
      log.info('Toggled MCP server', {
        namespace: 'mcp-service',
        name: opts.name,
        disabled: opts.disabled,
      });
    })(),
    (error) => internal(String(error instanceof Error ? error.message : String(error))),
  );
}

/**
 * Parse the text output of `claude mcp list`.
 *
 * Handles formats from `claude mcp list`:
 *   name: url (HTTP|SSE) - status       → HTTP/SSE server with explicit type
 *   name: command args - status          → stdio server (no type in parens)
 *   claude.ai Label: https://url - status → Claude.ai connector (name may contain spaces)
 *   plugin:org:tool: command - status   → Plugin-provided MCP server
 */
export function parseMcpListOutput(output: string): McpServer[] {
  const servers: McpServer[] = [];
  const lines = output.split('\n').filter((l) => l.trim());

  for (const line of lines) {
    const trimmed = line.trim();
    if (
      !trimmed ||
      trimmed.startsWith('─') ||
      trimmed.startsWith('Name') ||
      trimmed.startsWith('Checking')
    )
      continue;

    // Claude.ai connectors — display name includes spaces before the URL colon
    const claudeAiMatch = trimmed.match(/^(claude\.ai [^:]+):\s+(https?:\/\/\S+)\s+-\s+(.+)/);
    if (claudeAiMatch) {
      const server: McpServer = {
        name: claudeAiMatch[1].trim(),
        type: 'http',
        url: claudeAiMatch[2].trim(),
        toggleable: false,
      };
      applyStatus(server, claudeAiMatch[3].trim().toLowerCase());
      servers.push(server);
      continue;
    }

    // Plugin MCP servers — name is a single token with colons
    const pluginMatch = trimmed.match(/^(plugin:\S+):\s+(.+?)\s+-\s+(.+)/);
    if (pluginMatch) {
      const value = pluginMatch[2].trim();
      const server: McpServer = { name: pluginMatch[1], type: 'stdio', toggleable: false };
      const cmdParts = value.split(/\s+/);
      server.command = cmdParts[0];
      server.args = cmdParts.slice(1);
      applyStatus(server, pluginMatch[3].trim().toLowerCase());
      servers.push(server);
      continue;
    }

    // Match lines WITH explicit type: "name: value (HTTP|SSE|stdio) - status"
    const typedMatch = trimmed.match(
      /^(\S+):\s+(.+?)\s+\((HTTP|http|SSE|sse|stdio|STDIO)\)(?:\s*-\s*(.+))?/,
    );
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
  if (statusText.includes('disabled')) {
    server.disabled = true;
  } else if (statusText.includes('needs auth') || statusText.includes('authentication')) {
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
  provider?: AgentProvider;
  type: McpServerType;
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
  scope?: 'project' | 'user';
  projectPath: string;
}): ResultAsync<void, DomainError> {
  if (opts.provider === 'codex') return addCodexMcpServer(opts);

  const binary = getClaudeBinaryPath();
  const cliArgs: string[] = ['mcp', 'add'];

  cliArgs.push('--transport', opts.type);

  if (opts.scope) {
    cliArgs.push('--scope', opts.scope);
  }

  // Positional args (name, url/command) MUST come before variadic flags
  // like --header and --env. Commander.js treats variadic options as greedy,
  // so placing them before the name causes the name to be consumed as a flag value.
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

  // Variadic flags after positional args to avoid greedy consumption
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

  log.info('Adding MCP server', { namespace: 'mcp-service', binary, args: cliArgs });

  return ResultAsync.fromPromise(
    execute(binary, cliArgs, { cwd: opts.projectPath, timeout: 30_000 }).then(() => undefined),
    (error) => {
      if (error instanceof ProcessExecutionError) {
        return processError(error.message, error.exitCode, error.stderr);
      }
      return internal(String(error));
    },
  );
}

function addCodexMcpServer(opts: {
  name: string;
  type: McpServerType;
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
  projectPath: string;
}): ResultAsync<void, DomainError> {
  if (opts.headers && Object.keys(opts.headers).length > 0) {
    return ResultAsync.fromPromise(
      Promise.reject(new Error('Codex MCP CLI does not support arbitrary HTTP headers')),
      (error) => internal(String(error instanceof Error ? error.message : String(error))),
    );
  }

  const binary = getCodexBinaryPath();
  const cliArgs: string[] = ['mcp', 'add'];

  if (opts.type === 'sse') {
    return ResultAsync.fromPromise(
      Promise.reject(new Error('Codex MCP CLI supports stdio and streamable HTTP servers only')),
      (error) => internal(String(error instanceof Error ? error.message : String(error))),
    );
  }

  if (opts.type === 'stdio' && opts.env) {
    for (const [key, value] of Object.entries(opts.env)) {
      cliArgs.push('--env', `${key}=${value}`);
    }
  }

  if (opts.type === 'http') {
    if (!opts.url) {
      return ResultAsync.fromPromise(
        Promise.reject(new Error('URL is required for Codex HTTP MCP servers')),
        (error) => internal(String(error instanceof Error ? error.message : String(error))),
      );
    }
    cliArgs.push('--url', opts.url, opts.name);
  } else {
    if (!opts.command) {
      return ResultAsync.fromPromise(
        Promise.reject(new Error('Command is required for Codex stdio MCP servers')),
        (error) => internal(String(error instanceof Error ? error.message : String(error))),
      );
    }
    cliArgs.push(opts.name, '--', opts.command, ...(opts.args ?? []));
  }

  log.info('Adding Codex MCP server', { namespace: 'mcp-service', binary, args: cliArgs });

  return ResultAsync.fromPromise(
    execute(binary, cliArgs, { cwd: opts.projectPath, timeout: 30_000 }).then(() => undefined),
    (error) => {
      if (error instanceof ProcessExecutionError) {
        return processError(error.message, error.exitCode, error.stderr);
      }
      return internal(String(error));
    },
  );
}

/**
 * Remove an MCP server using the Claude CLI.
 */
export function removeMcpServer(opts: {
  name: string;
  projectPath: string;
  provider?: AgentProvider;
  scope?: 'project' | 'user';
}): ResultAsync<void, DomainError> {
  if (opts.provider === 'codex') return removeCodexMcpServer(opts);

  const binary = getClaudeBinaryPath();
  const cliArgs: string[] = ['mcp', 'remove'];

  if (opts.scope) {
    cliArgs.push('--scope', opts.scope);
  }

  cliArgs.push(opts.name);

  log.info('Removing MCP server', { namespace: 'mcp-service', binary, args: cliArgs });

  return ResultAsync.fromPromise(
    execute(binary, cliArgs, { cwd: opts.projectPath, timeout: 15_000 }).then(() => undefined),
    (error) => {
      if (error instanceof ProcessExecutionError) {
        return processError(error.message, error.exitCode, error.stderr);
      }
      return internal(String(error));
    },
  );
}

function removeCodexMcpServer(opts: {
  name: string;
  projectPath: string;
}): ResultAsync<void, DomainError> {
  const binary = getCodexBinaryPath();
  const cliArgs: string[] = ['mcp', 'remove', opts.name];

  log.info('Removing Codex MCP server', { namespace: 'mcp-service', binary, args: cliArgs });

  return ResultAsync.fromPromise(
    execute(binary, cliArgs, { cwd: opts.projectPath, timeout: 15_000 }).then(() => undefined),
    (error) => {
      if (error instanceof ProcessExecutionError) {
        return processError(error.message, error.exitCode, error.stderr);
      }
      return internal(String(error));
    },
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
    name: 'neon',
    description: 'Create and manage Neon Postgres databases and projects',
    type: 'http' as McpServerType,
    url: 'https://mcp.neon.tech/mcp',
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
    name: 'linear',
    description: 'Linear issues, projects, and team workflows',
    type: 'http' as McpServerType,
    url: 'https://mcp.linear.app/mcp',
  },
  {
    name: 'cloudflare',
    description: 'Manage Cloudflare Workers, DNS, R2, and other Cloudflare services',
    type: 'http' as McpServerType,
    url: 'https://mcp.cloudflare.com/mcp',
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
