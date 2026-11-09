import { spawnSync } from 'node:child_process';

import { describe, expect, test } from 'vitest';

import { sandboxGithubEnv } from '../../services/agent-startup/agent-env.js';

const sandboxEnv = { FUNNY_LLM_PROXY_TOKEN: 'llmp_abc', TEAM_SERVER_URL: 'https://funny.example' };

function credentialFill(env: Record<string, string>, host = 'github.com') {
  // Isolate from the developer's own git config and credential helpers.
  const result = spawnSync('git', ['credential', 'fill'], {
    input: `protocol=https\nhost=${host}\n\n`,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: '/nonexistent',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      ...env,
    },
    encoding: 'utf8',
  });
  return result;
}

describe('sandboxGithubEnv (thread-sandboxes)', () => {
  test('a sandbox agent gets the token for gh and a git credential helper', () => {
    const env = sandboxGithubEnv('ghp_secret', sandboxEnv);
    expect(env.GH_TOKEN).toBe('ghp_secret');
    expect(env.GIT_CONFIG_KEY_0).toBe('credential.https://github.com.helper');
  });

  test('git resolves the GitHub credential from the helper', () => {
    const result = credentialFill(sandboxGithubEnv('ghp_secret', sandboxEnv));
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('username=x-access-token');
    expect(result.stdout).toContain('password=ghp_secret');
  });

  test('the helper answers only for github.com', () => {
    const result = credentialFill(sandboxGithubEnv('ghp_secret', sandboxEnv), 'gitlab.com');
    expect(result.stdout).not.toContain('ghp_secret');
  });

  test('a normal runner keeps the user own git / gh login', () => {
    expect(sandboxGithubEnv('ghp_secret', { TEAM_SERVER_URL: 'https://funny.example' })).toEqual(
      {},
    );
  });

  test('no token → nothing injected', () => {
    expect(sandboxGithubEnv(null, sandboxEnv)).toEqual({});
  });
});
