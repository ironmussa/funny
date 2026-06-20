import { describe, expect, it } from 'bun:test';

import {
  DEFAULT_PROVIDER_RESOURCE_DESCRIPTOR,
  PROVIDER_RESOURCE_DESCRIPTORS,
  getProviderResourceDescriptor,
  resourceUsableByProvider,
  type AgentResource,
} from '../types/agent-resources.js';

describe('provider resource descriptors', () => {
  it('Claude carries filesystem skills and custom commands', () => {
    const d = PROVIDER_RESOURCE_DESCRIPTORS.claude;
    expect(d.skills).toContain('claude-project');
    expect(d.customCommands).toBe('claude-commands');
    expect(d.builtinCommands).toBe('session');
    expect(d.mcp.supported).toBe(true);
  });

  it('Codex carries its own filesystem skills (.codex/skills and .agents/skills) but no custom commands (v1)', () => {
    const d = PROVIDER_RESOURCE_DESCRIPTORS.codex;
    expect(d.skills).toEqual(['codex-global', 'codex-project']);
    expect(d.customCommands).toBe('none');
    expect(d.builtinCommands).toBe('session');
  });

  it('other non-Claude bundled providers have no filesystem skills or custom commands (v1)', () => {
    for (const provider of ['gemini', 'cursor', 'opencode', 'pi'] as const) {
      const d = PROVIDER_RESOURCE_DESCRIPTORS[provider];
      expect(d.skills).toBe('none');
      expect(d.customCommands).toBe('none');
      // built-ins still come from the session, never hardcoded/filesystem
      expect(d.builtinCommands).toBe('session');
    }
  });

  it('DeepAgent skills are template-bound', () => {
    expect(PROVIDER_RESOURCE_DESCRIPTORS.deepagent.skills).toEqual(['deepagent-template']);
  });

  it('unknown providers fall back to the permissive default (no Claude leakage)', () => {
    const d = getProviderResourceDescriptor('some-future-provider');
    expect(d).toBe(DEFAULT_PROVIDER_RESOURCE_DESCRIPTOR);
    expect(d.skills).toBe('none');
    expect(d.customCommands).toBe('none');
  });
});

describe('resourceUsableByProvider', () => {
  const claudeSkill: Pick<AgentResource, 'compatibleProviders'> = {
    compatibleProviders: ['claude'],
  };
  const sharedMcp: Pick<AgentResource, 'compatibleProviders'> = { compatibleProviders: 'all' };

  it('a Claude-only skill is usable by Claude but not Codex', () => {
    expect(resourceUsableByProvider(claudeSkill, 'claude')).toBe(true);
    expect(resourceUsableByProvider(claudeSkill, 'codex')).toBe(false);
  });

  it("an 'all'-compatible resource is usable by any provider", () => {
    expect(resourceUsableByProvider(sharedMcp, 'codex')).toBe(true);
    expect(resourceUsableByProvider(sharedMcp, 'gemini')).toBe(true);
  });
});
