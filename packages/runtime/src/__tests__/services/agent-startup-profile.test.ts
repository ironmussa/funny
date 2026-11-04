import { homedir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ resolveProfile: vi.fn() }));

vi.mock('../../services/service-registry.js', () => ({
  getServices: () => ({ agentProfiles: { resolveEffectiveProfile: mocks.resolveProfile } }),
}));

import { resolveActiveAgentProfile } from '../../services/agent-startup/agent-profile.js';
import type { RuntimeThreadRecord } from '../../services/server-interfaces.js';

const thread = { projectId: 'project-1', userId: 'user-1' } as RuntimeThreadRecord;
const profile = { id: 'profile-1', name: 'Work', provider: 'claude' };

describe('agent startup profile', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  test.each([
    ['~/.claude-work', join(homedir(), '.claude-work')],
    ['~', homedir()],
    [' /opt/claude-work ', '/opt/claude-work'],
  ])('normalizes %s on the runner before spawning the agent', async (configDir, expected) => {
    const stored = { profile, env: { CLAUDE_CONFIG_DIR: configDir, EXTRA: 'preserved' } };
    mocks.resolveProfile.mockResolvedValue(stored);

    expect(await resolveActiveAgentProfile(thread, 'claude')).toEqual({
      profile,
      env: { CLAUDE_CONFIG_DIR: expected, EXTRA: 'preserved' },
    });
    expect(mocks.resolveProfile).toHaveBeenCalledWith('project-1', 'user-1');
    expect(stored.env.CLAUDE_CONFIG_DIR).toBe(configDir);
  });

  test('does not apply a Claude profile to a different provider', async () => {
    mocks.resolveProfile.mockResolvedValue({ profile, env: { CLAUDE_CONFIG_DIR: '~/.work' } });
    expect(await resolveActiveAgentProfile(thread, 'codex')).toEqual({ profile: null, env: {} });
  });

  test('does not add a configuration directory when no profile exists', async () => {
    mocks.resolveProfile.mockResolvedValue({ profile: null, env: {} });
    expect(await resolveActiveAgentProfile(thread, 'claude')).toEqual({ profile: null, env: {} });
  });

  test('does not resolve a profile without a thread', async () => {
    expect(await resolveActiveAgentProfile(undefined, 'claude')).toEqual({
      profile: null,
      env: {},
    });
    expect(mocks.resolveProfile).not.toHaveBeenCalled();
  });
});
