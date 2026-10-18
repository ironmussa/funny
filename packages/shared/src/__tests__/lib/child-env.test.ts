/**
 * Security M8 — child processes (agents, PTYs, commands, git hooks) must not
 * inherit funny's infrastructure secrets.
 */
import { describe, test, expect } from 'bun:test';

import {
  SENSITIVE_ENV_VARS,
  buildChildEnv,
  isSensitiveEnvVar,
  scrubSensitiveEnv,
} from '../../lib/child-env.js';

const PARENT = {
  PATH: '/usr/bin',
  HOME: '/home/u',
  ANTHROPIC_API_KEY: 'sk-user-provider-key',
  GH_TOKEN: 'ghp_user',
  RUNNER_AUTH_SECRET: 'root-secret',
  RUNNER_INVITE_TOKEN: 'invite',
  FUNNY_RUNNER_FORWARDING_KEY: 'k_r',
  SCHEDULER_AUTH_SECRET: 'sched',
  INGEST_WEBHOOK_SECRET: 'ingest',
  DATABASE_URL: 'postgres://u:p@db/funny',
  BETTER_AUTH_SECRET: 'better',
};

describe('child env scrubbing', () => {
  test('buildChildEnv drops every sensitive var from the parent env', () => {
    const env = buildChildEnv({ FORCE_COLOR: '1' }, PARENT);
    for (const name of [
      'RUNNER_AUTH_SECRET',
      'RUNNER_INVITE_TOKEN',
      'FUNNY_RUNNER_FORWARDING_KEY',
      'SCHEDULER_AUTH_SECRET',
      'INGEST_WEBHOOK_SECRET',
      'DATABASE_URL',
      'BETTER_AUTH_SECRET',
    ]) {
      expect(env[name]).toBeUndefined();
    }
    expect(env.FORCE_COLOR).toBe('1');
  });

  test('keeps ordinary vars and user-provider credentials agents need', () => {
    const env = scrubSensitiveEnv(PARENT);
    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/home/u');
    expect(env.ANTHROPIC_API_KEY).toBe('sk-user-provider-key');
    expect(env.GH_TOKEN).toBe('ghp_user');
  });

  test('defaults to scrubbing the real process.env', () => {
    const prev = process.env.RUNNER_AUTH_SECRET;
    process.env.RUNNER_AUTH_SECRET = 'leak-me';
    try {
      expect(buildChildEnv().RUNNER_AUTH_SECRET).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.RUNNER_AUTH_SECRET;
      else process.env.RUNNER_AUTH_SECRET = prev;
    }
  });

  test('matching is case-insensitive and the list covers the runner secrets', () => {
    expect(isSensitiveEnvVar('runner_auth_secret')).toBe(true);
    expect(SENSITIVE_ENV_VARS).toContain('RUNNER_AUTH_SECRET');
    expect(SENSITIVE_ENV_VARS).toContain('DATABASE_URL');
  });
});
