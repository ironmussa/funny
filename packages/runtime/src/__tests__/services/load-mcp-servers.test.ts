import type { McpServer } from '@funny/shared';
import { okAsync } from 'neverthrow';
import { describe, test, expect, vi, beforeEach } from 'vitest';

const { listMcpServers } = vi.hoisted(() => ({ listMcpServers: vi.fn() }));
vi.mock('../../services/mcp-service.js', () => ({ listMcpServers }));

import { loadProjectMcpServers } from '../../services/agent-startup/load-mcp-servers.js';

const stdioServer: McpServer = {
  name: 'ctx7',
  type: 'stdio',
  command: 'ctx7',
  args: ['--stdio'],
  source: 'project',
};

beforeEach(() => {
  listMcpServers.mockReset().mockReturnValue(okAsync([stdioServer]));
});

describe('loadProjectMcpServers — provider scoping', () => {
  test('Claude receives enabled project MCP servers (unchanged behavior)', async () => {
    const result = await loadProjectMcpServers('t1', '/p', 'claude');
    expect(result).toBeDefined();
    expect(result?.ctx7).toMatchObject({ type: 'stdio', command: 'ctx7' });
  });

  test('a provider with no MCP support gets nothing injected', async () => {
    const result = await loadProjectMcpServers('t1', '/p', 'llm-api');
    expect(result).toBeUndefined();
    // short-circuits before even listing servers
    expect(listMcpServers).not.toHaveBeenCalled();
  });

  test('disabled servers are excluded', async () => {
    listMcpServers.mockReturnValue(okAsync([{ ...stdioServer, disabled: true }]));
    const result = await loadProjectMcpServers('t1', '/p', 'claude');
    expect(result).toBeUndefined();
  });
});
