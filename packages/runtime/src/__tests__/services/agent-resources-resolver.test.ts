import type { AgentResource, McpServer } from '@funny/shared';
import { okAsync } from 'neverthrow';
import { describe, test, expect, vi, beforeEach } from 'vitest';

const { listSkillResourcesForProvider, listCustomCommandResourcesForProvider, listMcpServers } =
  vi.hoisted(() => ({
    listSkillResourcesForProvider: vi.fn<
      (p: string, path?: string, options?: { claudeConfigDir?: string }) => AgentResource[]
    >(() => []),
    listCustomCommandResourcesForProvider: vi.fn<
      (p: string, path?: string, options?: { claudeConfigDir?: string }) => AgentResource[]
    >(() => []),
    listMcpServers: vi.fn(),
  }));

vi.mock('../../services/skills-service.js', () => ({
  listSkillResourcesForProvider,
  listCustomCommandResourcesForProvider,
}));
vi.mock('../../services/mcp-service.js', () => ({ listMcpServers }));

import { resolveAgentResources } from '../../services/agent-resources/resolver.js';

const claudeSkill: AgentResource = {
  kind: 'skill',
  name: 'skill-creator',
  origin: 'claude-global',
  compatibleProviders: ['claude'],
  usable: true,
};
const codexSkill: AgentResource = {
  kind: 'skill',
  name: 'imagegen',
  origin: 'codex-global',
  compatibleProviders: ['codex'],
  usable: true,
};

beforeEach(() => {
  // Return each provider's OWN skills, keyed by the provider argument.
  listSkillResourcesForProvider.mockReset().mockImplementation((p: string) => {
    if (p === 'claude') return [claudeSkill];
    if (p === 'codex') return [codexSkill];
    return [];
  });
  listCustomCommandResourcesForProvider.mockReset().mockReturnValue([]);
  listMcpServers.mockReset().mockReturnValue(okAsync([] as McpServer[]));
});

describe('resolveAgentResources — skills', () => {
  test('Claude sees its skills as usable', async () => {
    const res = (
      await resolveAgentResources({ provider: 'claude', phase: 'composer', projectPath: '/p' })
    )._unsafeUnwrap();
    expect(res.resources.map((r) => r.name)).toContain('skill-creator');
    expect(res.hidden).toHaveLength(0);
  });

  test('Codex sees its OWN filesystem skills in the composer', async () => {
    const res = (
      await resolveAgentResources({ provider: 'codex', phase: 'composer', projectPath: '/p' })
    )._unsafeUnwrap();
    // Codex's own skill is usable; Claude's skill is not even scanned.
    expect(res.resources.map((r) => r.name)).toContain('imagegen');
    expect(res.resources.find((r) => r.name === 'skill-creator')).toBeUndefined();
    expect(listSkillResourcesForProvider).toHaveBeenCalledWith('codex', '/p', {
      claudeConfigDir: undefined,
    });
    expect(
      listSkillResourcesForProvider.mock.calls.some(([provider]) => provider === 'claude'),
    ).toBe(false);
  });

  test('Settings inventory shows Claude skills under Claude even when targeting Codex', async () => {
    const res = (
      await resolveAgentResources({ provider: 'codex', phase: 'settings', projectPath: '/p' })
    )._unsafeUnwrap();
    // Codex's own skills are usable; Claude's are incompatible (audit only).
    expect(res.resources.find((r) => r.name === 'imagegen')).toBeDefined();
    expect(res.resources.find((r) => r.name === 'skill-creator')).toBeUndefined();
    expect(res.hidden.find((r) => r.name === 'skill-creator')?.hiddenReason).toBe(
      'provider_mismatch',
    );
  });
});

describe('resolveAgentResources — session commands', () => {
  test('built-in session commands are compatible with the reporting provider', async () => {
    const res = (
      await resolveAgentResources({
        provider: 'codex',
        phase: 'composer',
        sessionCommands: ['init', 'review'],
      })
    )._unsafeUnwrap();
    const cmd = res.resources.find((r) => r.name === 'init');
    expect(cmd?.kind).toBe('slash-command');
    expect(cmd?.commandTier).toBe('builtin');
    expect(cmd?.origin).toBe('provider-session');
  });
});

describe('resolveAgentResources — MCP', () => {
  const mcp = (over: Partial<McpServer>): McpServer => ({
    name: 'ctx7',
    type: 'stdio',
    source: 'project',
    ...over,
  });

  test('composer skips MCP listing because autocomplete only needs skills and slash commands', async () => {
    const res = (
      await resolveAgentResources({ provider: 'codex', phase: 'composer', projectPath: '/p' })
    )._unsafeUnwrap();
    expect(res.resources.find((r) => r.kind === 'mcp-server')).toBeUndefined();
    expect(listMcpServers).not.toHaveBeenCalled();
  });

  test('disabled MCP server is hidden with reason disabled', async () => {
    listMcpServers.mockReturnValue(okAsync([mcp({ disabled: true })]));
    const res = (
      await resolveAgentResources({ provider: 'claude', phase: 'runtime', projectPath: '/p' })
    )._unsafeUnwrap();
    expect(res.resources.find((r) => r.kind === 'mcp-server')).toBeUndefined();
    expect(res.hidden.find((r) => r.name === 'ctx7')?.hiddenReason).toBe('disabled');
  });

  test('enabled stdio MCP is injected for Claude', async () => {
    listMcpServers.mockReturnValue(okAsync([mcp({})]));
    const res = (
      await resolveAgentResources({ provider: 'claude', phase: 'runtime', projectPath: '/p' })
    )._unsafeUnwrap();
    expect(res.resources.find((r) => r.name === 'ctx7')?.usable).toBe(true);
    expect(listMcpServers).toHaveBeenCalledWith('/p', 'claude', {
      claudeConfigDir: undefined,
    });
  });

  test('runtime lists MCP for the requested provider', async () => {
    listMcpServers.mockReturnValue(okAsync([mcp({ provider: 'codex', type: 'http' })]));
    const res = (
      await resolveAgentResources({ provider: 'codex', phase: 'runtime', projectPath: '/p' })
    )._unsafeUnwrap();
    expect(res.resources.find((r) => r.name === 'ctx7')?.usable).toBe(true);
    expect(listMcpServers).toHaveBeenCalledWith('/p', 'codex', {
      claudeConfigDir: undefined,
    });
  });

  test('MCP is unsupported for llm-api (no transports)', async () => {
    listMcpServers.mockReturnValue(okAsync([mcp({})]));
    const res = (
      await resolveAgentResources({ provider: 'llm-api', phase: 'runtime', projectPath: '/p' })
    )._unsafeUnwrap();
    expect(res.hidden.find((r) => r.name === 'ctx7')?.hiddenReason).toBe('unsupported_transport');
  });
});
