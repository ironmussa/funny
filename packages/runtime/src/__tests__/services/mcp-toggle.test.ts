import { describe, expect, test, vi, beforeEach } from 'vitest';

const fsMocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
  readFile: fsMocks.readFile,
  writeFile: fsMocks.writeFile,
}));

const mockReadFile = fsMocks.readFile;
const mockWriteFile = fsMocks.writeFile;

import { isExternallyManagedMcpServer, toggleMcpServer } from '../../services/mcp-service.js';

const PROJECT = '/tmp/funny-project';

function mockClaudeConfig(config: Record<string, unknown>) {
  mockReadFile.mockImplementation(async (path) => {
    if (String(path).endsWith('.claude.json')) return JSON.stringify(config);
    if (String(path).endsWith('.mcp.json')) throw new Error('ENOENT');
    throw new Error(`unexpected read: ${path}`);
  });
}

describe('isExternallyManagedMcpServer', () => {
  test('detects plugin servers', () => {
    expect(isExternallyManagedMcpServer('plugin:sentrux:sentrux')).toBe(true);
  });

  test('detects claude.ai connectors', () => {
    expect(isExternallyManagedMcpServer('claude.ai Google Drive')).toBe(true);
    expect(isExternallyManagedMcpServer('claude_ai_Google_Drive')).toBe(true);
  });

  test('allows user-configured servers', () => {
    expect(isExternallyManagedMcpServer('codegraph')).toBe(false);
    expect(isExternallyManagedMcpServer('neon')).toBe(false);
  });
});

describe('toggleMcpServer', () => {
  beforeEach(() => {
    mockReadFile.mockReset();
    mockWriteFile.mockReset();
  });

  test('rejects externally managed plugin servers', async () => {
    mockClaudeConfig({ projects: { [PROJECT]: {} } });

    const result = await toggleMcpServer({
      name: 'plugin:sentrux:sentrux',
      projectPath: PROJECT,
      disabled: true,
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.message).toContain('cannot be toggled');
    }
  });

  test('toggles global user-scoped servers from root ~/.claude.json mcpServers', async () => {
    mockClaudeConfig({
      mcpServers: {
        codegraph: { type: 'stdio', command: 'codegraph', args: ['serve', '--mcp'] },
      },
      projects: { [PROJECT]: {} },
    });

    const result = await toggleMcpServer({
      name: 'codegraph',
      projectPath: PROJECT,
      disabled: true,
    });

    expect(result.isOk()).toBe(true);
    expect(mockWriteFile).toHaveBeenCalledOnce();

    const written = JSON.parse(String(mockWriteFile.mock.calls[0][1]));
    expect(written.projects[PROJECT].disabledMcpServers).toEqual(['codegraph']);
  });

  test('returns not found when server is absent from all config sources', async () => {
    mockClaudeConfig({ projects: { [PROJECT]: {} } });

    const result = await toggleMcpServer({
      name: 'missing-server',
      projectPath: PROJECT,
      disabled: true,
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.message).toContain('not found');
    }
  });

  test('re-enabling clears root-level disabledMcpServers for user-scoped servers', async () => {
    mockClaudeConfig({
      mcpServers: {
        codegraph: { type: 'stdio', command: 'codegraph', args: ['serve', '--mcp'] },
      },
      disabledMcpServers: ['codegraph'],
      projects: { [PROJECT]: {} },
    });

    const result = await toggleMcpServer({
      name: 'codegraph',
      projectPath: PROJECT,
      disabled: false,
    });

    expect(result.isOk()).toBe(true);
    const written = JSON.parse(String(mockWriteFile.mock.calls[0][1]));
    expect(written.disabledMcpServers).toEqual([]);
    expect(written.projects[PROJECT].disabledMcpServers ?? []).toEqual([]);
  });

  test('toggles project .mcp.json servers via disabledMcpjsonServers', async () => {
    mockReadFile.mockImplementation(async (path) => {
      if (String(path).endsWith('.claude.json')) {
        return JSON.stringify({ projects: { [PROJECT]: {} } });
      }
      if (String(path).endsWith('.mcp.json')) {
        return JSON.stringify({
          mcpServers: { supabase: { type: 'stdio', command: 'npx', args: ['-y', 'mcp-supabase'] } },
        });
      }
      throw new Error(`unexpected read: ${path}`);
    });

    const result = await toggleMcpServer({
      name: 'supabase',
      projectPath: PROJECT,
      disabled: true,
    });

    expect(result.isOk()).toBe(true);
    const written = JSON.parse(String(mockWriteFile.mock.calls[0][1]));
    expect(written.projects[PROJECT].disabledMcpjsonServers).toEqual(['supabase']);
  });
});
