import { describe, expect, test, vi, beforeEach } from 'vitest';

const fsMocks = vi.hoisted(() => ({ readFile: vi.fn(), writeFile: vi.fn() }));
vi.mock('node:fs/promises', () => ({ readFile: fsMocks.readFile, writeFile: fsMocks.writeFile }));

const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock('@funny/core/git', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  execute,
}));

import { listConfiguredClaudeMcpServers } from '../../services/mcp-service.js';

const PROJECT = '/tmp/funny-project';

function mockFiles(claudeJson: Record<string, unknown>, mcpJson?: Record<string, unknown>) {
  fsMocks.readFile.mockImplementation(async (path: unknown) => {
    if (String(path).endsWith('.claude.json')) return JSON.stringify(claudeJson);
    if (String(path).endsWith('.mcp.json')) {
      if (!mcpJson) throw new Error('ENOENT');
      return JSON.stringify({ mcpServers: mcpJson });
    }
    throw new Error(`unexpected read: ${path}`);
  });
}

beforeEach(() => {
  fsMocks.readFile.mockReset();
  execute.mockReset();
});

describe('listConfiguredClaudeMcpServers', () => {
  test('reads user, project-local and .mcp.json servers without running the CLI', async () => {
    mockFiles(
      {
        mcpServers: { codegraph: { type: 'stdio', command: 'codegraph', args: ['serve'] } },
        projects: {
          [PROJECT]: { mcpServers: { neon: { type: 'http', url: 'https://neon.test/mcp' } } },
        },
      },
      { fallow: { type: 'stdio', command: 'fallow-mcp', args: [] } },
    );

    const result = await listConfiguredClaudeMcpServers(PROJECT);

    expect(result._unsafeUnwrap()).toEqual([
      {
        name: 'codegraph',
        provider: 'claude',
        type: 'stdio',
        source: 'user',
        command: 'codegraph',
        args: ['serve'],
      },
      {
        name: 'neon',
        provider: 'claude',
        type: 'http',
        source: 'user',
        url: 'https://neon.test/mcp',
      },
      {
        name: 'fallow',
        provider: 'claude',
        type: 'stdio',
        source: 'project',
        command: 'fallow-mcp',
        args: [],
      },
    ]);
    expect(execute).not.toHaveBeenCalled();
  });

  test('marks servers disabled for the project path', async () => {
    mockFiles(
      {
        mcpServers: { codegraph: { command: 'codegraph' } },
        disabledMcpServers: ['codegraph'],
        projects: { [PROJECT]: { disabledMcpjsonServers: ['fallow'] } },
      },
      { fallow: { command: 'fallow-mcp' }, ctx7: { command: 'ctx7' } },
    );

    const servers = (await listConfiguredClaudeMcpServers(PROJECT))._unsafeUnwrap();

    expect(Object.fromEntries(servers.map((s) => [s.name, s.disabled ?? false]))).toEqual({
      codegraph: true,
      fallow: true,
      ctx7: false,
    });
  });

  test('a .mcp.json server wins over a user server with the same name', async () => {
    mockFiles(
      { mcpServers: { fallow: { command: 'old-fallow' } } },
      { fallow: { command: 'fallow-mcp' } },
    );

    const servers = (await listConfiguredClaudeMcpServers(PROJECT))._unsafeUnwrap();

    expect(servers).toHaveLength(1);
    expect(servers[0]).toMatchObject({ source: 'project', command: 'fallow-mcp' });
  });

  test('missing config files give an empty list', async () => {
    fsMocks.readFile.mockRejectedValue(new Error('ENOENT'));
    expect((await listConfiguredClaudeMcpServers(PROJECT))._unsafeUnwrap()).toEqual([]);
  });
});
