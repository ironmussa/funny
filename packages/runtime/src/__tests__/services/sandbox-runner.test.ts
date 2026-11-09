/**
 * sandbox-runner.ts — an agent profile's machine paths do not apply on a
 * sandbox runner (a laptop CLAUDE_CONFIG_DIR made every resume fail there).
 */
import { describe, expect, test } from 'vitest';

import { isSandboxRunner, profileForThisRunner } from '../../services/sandbox-runner.js';

const profile = { id: 'p1', name: 'argenis', provider: 'claude' } as any;
const resolved = {
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
