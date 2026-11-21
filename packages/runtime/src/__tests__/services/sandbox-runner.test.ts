import { describe, expect, test } from 'bun:test';

/**
 * sandbox-runner.ts — an agent profile's machine paths do not apply on a
 * sandbox runner (a laptop CLAUDE_CONFIG_DIR made every resume fail there).
 */
import type {
  AgentExecutionProfileResponse,
  ResolvedAgentExecutionProfileResponse,
} from '@funny/shared';

import { isSandboxRunner, profileForThisRunner } from '../../services/sandbox-runner.js';

const profile: AgentExecutionProfileResponse = {
  id: 'p1',
  name: 'argenis',
  provider: 'claude',
  config: { claude: { configDir: '/home/me/.claude-me' } },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};
const resolved: ResolvedAgentExecutionProfileResponse = {
  profile,
  env: { CLAUDE_CONFIG_DIR: '/home/me/.claude-me', EXTRA: 'kept' },
};
const sandbox = { FUNNY_LLM_PROXY_TOKEN: 'llmp_x' };

describe('sandbox runner', () => {
  test('is recognised by its LLM proxy token', () => {
    expect(isSandboxRunner(sandbox)).toBe(true);
    expect(isSandboxRunner({})).toBe(false);
    expect(isSandboxRunner({ FUNNY_LLM_PROXY_TOKEN: '  ' })).toBe(false);
  });

  test('drops the profile CLAUDE_CONFIG_DIR on a sandbox, keeping the rest', () => {
    expect(profileForThisRunner(resolved, sandbox)).toEqual({ profile, env: { EXTRA: 'kept' } });
    expect(resolved.env.CLAUDE_CONFIG_DIR).toBe('/home/me/.claude-me');
  });

  test('keeps the profile as is on the user own runner', () => {
    expect(profileForThisRunner(resolved, {})).toBe(resolved);
  });
});
