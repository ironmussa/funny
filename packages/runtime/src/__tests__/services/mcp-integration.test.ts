import { describe, expect, test, vi, beforeEach } from 'vitest';

const fsMocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
}));

const executeMock = vi.hoisted(() => vi.fn());

vi.mock('node:fs/promises', () => ({
  readFile: fsMocks.readFile,
  writeFile: fsMocks.writeFile,
}));

vi.mock('@funny/core/git', () => ({
  execute: executeMock,
  ProcessExecutionError: class ProcessExecutionError extends Error {
    exitCode: number;
    stderr: string;
    constructor(message: string, exitCode: number, stderr: string) {
      super(message);
      this.exitCode = exitCode;
      this.stderr = stderr;
    }
  },
}));

vi.mock('../../utils/claude-binary.js', () => ({
  getClaudeBinaryPath: () => '/usr/bin/claude',
}));

import { loadProjectMcpServers } from '../../services/agent-startup/load-mcp-servers.js';
import { listMcpServers, toggleMcpServer } from '../../services/mcp-service.js';

const PROJECT = '/tmp/funny-project';
const THREAD_ID = 'thread-mcp-integration';

function stubCliList(stdout: string) {
  executeMock.mockResolvedValue({ stdout, stderr: '', exitCode: 0 });
}

/** In-memory ~/.claude.json — writeFile updates what readFile returns on next read */
function useClaudeConfigStore(initial: Record<string, unknown>) {
  let config = structuredClone(initial);

  fsMocks.readFile.mockImplementation(async (path) => {
    if (String(path).endsWith('.claude.json')) return JSON.stringify(config);
    if (String(path).endsWith('.mcp.json')) throw new Error('ENOENT');
    throw new Error(`unexpected read: ${path}`);
  });

  fsMocks.writeFile.mockImplementation(async (_path, data) => {
    config = JSON.parse(String(data));
  });

  return {
    getConfig: () => config,
  };
}

describe('MCP list + toggle integration', () => {
  beforeEach(() => {
    fsMocks.readFile.mockReset();
    fsMocks.writeFile.mockReset();
    executeMock.mockReset();
    stubCliList('No MCP servers configured');
  });

  test('listMcpServers surfaces user servers disabled only at root disabledMcpServers', async () => {
    useClaudeConfigStore({
      mcpServers: {
        codegraph: { type: 'stdio', command: 'codegraph', args: ['serve', '--mcp'] },
      },
      disabledMcpServers: ['codegraph'],
      projects: { [PROJECT]: {} },
    });

    const result = await listMcpServers(PROJECT);
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    const codegraph = result.value.find((s) => s.name === 'codegraph');
    expect(codegraph).toMatchObject({
      disabled: true,
      source: 'user',
      type: 'stdio',
      command: 'codegraph',
    });
  });

  test('listMcpServers marks CLI-listed user server disabled when root disabledMcpServers matches', async () => {
    useClaudeConfigStore({
      mcpServers: {
        neon: { type: 'http', url: 'https://mcp.neon.tech/mcp' },
      },
      disabledMcpServers: ['neon'],
      projects: { [PROJECT]: {} },
    });

    stubCliList('neon: https://mcp.neon.tech/mcp (HTTP) - ✓ Connected\n');

    const result = await listMcpServers(PROJECT);
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    expect(result.value).toHaveLength(1);
    expect(result.value[0]).toMatchObject({
      name: 'neon',
      disabled: true,
      source: 'user',
    });
  });

  test('disable → list → loadProjectMcpServers excludes server from agent config', async () => {
    useClaudeConfigStore({
      mcpServers: {
        codegraph: { type: 'stdio', command: 'codegraph', args: ['serve', '--mcp'] },
      },
      projects: { [PROJECT]: {} },
    });

    stubCliList('codegraph: codegraph serve --mcp - ✓ Connected\n');

    const disable = await toggleMcpServer({
      name: 'codegraph',
      projectPath: PROJECT,
      disabled: true,
    });
    expect(disable.isOk()).toBe(true);

    const listAfterDisable = await listMcpServers(PROJECT);
    expect(listAfterDisable.isOk()).toBe(true);
    if (!listAfterDisable.isOk()) return;
    expect(listAfterDisable.value.find((s) => s.name === 'codegraph')?.disabled).toBe(true);

    const loaded = await loadProjectMcpServers(THREAD_ID, PROJECT, 'claude');
    expect(loaded).toBeUndefined();
  });

  test('root disable → re-enable → list → loadProjectMcpServers includes server again', async () => {
    const store = useClaudeConfigStore({
      mcpServers: {
        codegraph: { type: 'stdio', command: 'codegraph', args: ['serve', '--mcp'] },
      },
      disabledMcpServers: ['codegraph'],
      projects: { [PROJECT]: {} },
    });

    stubCliList('No MCP servers configured');

    let listDisabled = await listMcpServers(PROJECT);
    expect(listDisabled.isOk()).toBe(true);
    if (!listDisabled.isOk()) return;
    expect(listDisabled.value.find((s) => s.name === 'codegraph')?.disabled).toBe(true);

    const enable = await toggleMcpServer({
      name: 'codegraph',
      projectPath: PROJECT,
      disabled: false,
    });
    expect(enable.isOk()).toBe(true);
    expect(store.getConfig().disabledMcpServers ?? []).toEqual([]);

    stubCliList('codegraph: codegraph serve --mcp - ✓ Connected\n');

    const listEnabled = await listMcpServers(PROJECT);
    expect(listEnabled.isOk()).toBe(true);
    if (!listEnabled.isOk()) return;
    const codegraph = listEnabled.value.find((s) => s.name === 'codegraph');
    expect(codegraph?.disabled).not.toBe(true);

    const loaded = await loadProjectMcpServers(THREAD_ID, PROJECT, 'claude');
    expect(loaded).toEqual({
      codegraph: {
        type: 'stdio',
        command: 'codegraph',
        args: ['serve', '--mcp'],
      },
    });
  });

  test('listMcpServers includes disabled .mcp.json server omitted from CLI output', async () => {
    fsMocks.readFile.mockImplementation(async (path) => {
      if (String(path).endsWith('.claude.json')) {
        return JSON.stringify({
          projects: {
            [PROJECT]: { disabledMcpjsonServers: ['supabase'] },
          },
        });
      }
      if (String(path).endsWith('.mcp.json')) {
        return JSON.stringify({
          mcpServers: {
            supabase: { type: 'stdio', command: 'npx', args: ['-y', 'mcp-supabase'] },
          },
        });
      }
      throw new Error(`unexpected read: ${path}`);
    });

    stubCliList('No MCP servers configured');

    const result = await listMcpServers(PROJECT);
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    expect(result.value).toHaveLength(1);
    expect(result.value[0]).toMatchObject({
      name: 'supabase',
      disabled: true,
      source: 'project',
      type: 'stdio',
      command: 'npx',
      args: ['-y', 'mcp-supabase'],
    });
  });
});
