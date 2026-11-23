/**
 * The factory's git configuration in its agents' environment (openspec
 * factory-integration 3.1): added after any GIT_CONFIG_* already there, only
 * for a factory thread that may write.
 */
import { describe, expect, test } from 'bun:test';

import { appendGitConfigEnv, withFactoryGitEnv } from '../../services/agent-startup/factory-git.js';

describe('appendGitConfigEnv', () => {
  test('appends after the entries the environment already has', () => {
    const env = {
      PATH: '/bin',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'credential.helper',
      GIT_CONFIG_VALUE_0: '!gh auth git-credential',
    };
    const merged = appendGitConfigEnv(env, {
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'rerere.enabled',
      GIT_CONFIG_VALUE_0: 'true',
      GIT_CONFIG_KEY_1: 'rerere.autoUpdate',
      GIT_CONFIG_VALUE_1: 'true',
    });
    expect(merged).toEqual({
      ...env,
      GIT_CONFIG_COUNT: '3',
      GIT_CONFIG_KEY_1: 'rerere.enabled',
      GIT_CONFIG_VALUE_1: 'true',
      GIT_CONFIG_KEY_2: 'rerere.autoUpdate',
      GIT_CONFIG_VALUE_2: 'true',
    });
  });
});

describe('withFactoryGitEnv', () => {
  test('a factory thread that writes gets rerere', async () => {
    const env = await withFactoryGitEnv({ PATH: '/bin' }, { source: 'factory' }, false);
    const keys = Object.entries(env ?? {})
      .filter(([name]) => name.startsWith('GIT_CONFIG_KEY_'))
      .map(([, key]) => key);
    expect(keys).toContain('rerere.enabled');
    expect(env?.PATH).toBe('/bin');
  });

  test('a read-only role and a thread a person started are left alone', async () => {
    const env = { PATH: '/bin' };
    expect(await withFactoryGitEnv(env, { source: 'factory' }, true)).toBe(env);
    expect(await withFactoryGitEnv(env, { source: 'web' }, false)).toBe(env);
  });
});
