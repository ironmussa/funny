import type { McpServer } from '@funny/shared';
import { okAsync } from 'neverthrow';
import { describe, test, expect, vi, beforeEach } from 'vitest';

const { listMcpServers, listConfiguredClaudeMcpServers } = vi.hoisted(() => ({
  listMcpServers: vi.fn(),
  listConfiguredClaudeMcpServers: vi.fn(),
}));
vi.mock('../../services/mcp-service.js', () => ({
  listMcpServers,
  listConfiguredClaudeMcpServers,
}));

import { loadProjectMcpServers } from '../../services/agent-startup/load-mcp-servers.js';

const stdioServer: McpServer = {
  name: 'ctx7',
  type: 'stdio',
  command: 'ctx7',
  args: ['--stdio'],
  source: 'project',
};

const WORKTREE = '/worktrees/p-branch';

beforeEach(() => {
  listMcpServers.mockReset().mockReturnValue(okAsync([stdioServer]));
  listConfiguredClaudeMcpServers.mockReset().mockReturnValue(okAsync([stdioServer]));
});

describe('loadProjectMcpServers — provider scoping', () => {
  test('Claude in a worktree receives the configured project servers', async () => {
    const result = await loadProjectMcpServers('t1', '/p', 'claude', { cwd: WORKTREE });
    expect(result).toBeDefined();
    expect(result?.ctx7).toMatchObject({ type: 'stdio', command: 'ctx7' });
    expect(listConfiguredClaudeMcpServers).toHaveBeenCalledWith('/p', {
      claudeConfigDir: undefined,
    });
  });

  test('Claude never runs the `claude mcp list` health check at startup', async () => {
    await loadProjectMcpServers('t1', '/p', 'claude', { cwd: WORKTREE });
    expect(listMcpServers).not.toHaveBeenCalled();
  });

  test('Claude in the project directory gets nothing injected (the CLI loads its own config)', async () => {
    const result = await loadProjectMcpServers('t1', '/p', 'claude', { cwd: '/p/' });
    expect(result).toBeUndefined();
    expect(listConfiguredClaudeMcpServers).not.toHaveBeenCalled();
    expect(listMcpServers).not.toHaveBeenCalled();
  });

  test('a provider with no MCP support gets nothing injected', async () => {
    const result = await loadProjectMcpServers('t1', '/p', 'llm-api');
    expect(result).toBeUndefined();
    // short-circuits before even listing servers
    expect(listMcpServers).not.toHaveBeenCalled();
    expect(listConfiguredClaudeMcpServers).not.toHaveBeenCalled();
  });

  test('disabled servers are excluded', async () => {
    listConfiguredClaudeMcpServers.mockReturnValue(okAsync([{ ...stdioServer, disabled: true }]));
    const result = await loadProjectMcpServers('t1', '/p', 'claude', { cwd: WORKTREE });
    expect(result).toBeUndefined();
  });

  test('auth-blocked servers are excluded', async () => {
    listMcpServers.mockReturnValue(okAsync([{ ...stdioServer, status: 'needs_auth' }]));
    const result = await loadProjectMcpServers('t1', '/p', 'codex');
    expect(result).toBeUndefined();
  });

  test('errored servers are excluded', async () => {
    listMcpServers.mockReturnValue(okAsync([{ ...stdioServer, status: 'error' }]));
    const result = await loadProjectMcpServers('t1', '/p', 'codex');
    expect(result).toBeUndefined();
  });

  test('Codex reads the Codex MCP inventory, even in the project directory', async () => {
    const result = await loadProjectMcpServers('t1', '/p', 'codex', { cwd: '/p' });
    expect(result).toBeDefined();
    expect(listMcpServers).toHaveBeenCalledWith('/p', 'codex', { claudeConfigDir: undefined });
  });

  test('claude.ai connectors are never injected (the CLI loads them with their own auth)', async () => {
    listConfiguredClaudeMcpServers.mockReturnValue(
      okAsync([
        stdioServer,
        {
          name: 'claude.ai Gmail',
          type: 'http',
          url: 'https://gmailmcp.googleapis.com/mcp/v1',
          toggleable: false,
        },
        { name: 'claude_ai_Drive', type: 'http', url: 'https://example.test/mcp' },
      ] satisfies McpServer[]),
    );
    const result = await loadProjectMcpServers('t1', '/p', 'claude', { cwd: WORKTREE });
    expect(Object.keys(result ?? {})).toEqual(['ctx7']);
  });
});
