// Project secrets at agent start (openspec project-secrets): what the runtime
// does with the server's answer, and the order the agent env is composed in.

import { describe, expect, test, vi } from 'bun:test';

vi.mock('../../lib/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  composeAgentEnv,
  loadProjectSecrets,
  redactDeep,
} from '../../services/agent-startup/project-secrets.js';

describe('loadProjectSecrets', () => {
  test('returns the secrets the server delivered', async () => {
    const loaded = await loadProjectSecrets('t1', async () => ({
      secrets: [{ name: 'API_KEY', value: 'value-1' }],
    }));
    expect(loaded._unsafeUnwrap()).toEqual([{ name: 'API_KEY', value: 'value-1' }]);
  });

  test('a server from before the change means no secrets, not a failure', async () => {
    const loaded = await loadProjectSecrets('t1', async () => {
      throw new Error('operation is not allowed');
    });
    expect(loaded._unsafeUnwrap()).toEqual([]);
  });

  test('any other refusal is an error', async () => {
    const forbidden = await loadProjectSecrets('t1', async () => {
      throw new Error('Forbidden');
    });
    expect(forbidden._unsafeUnwrapErr()).toContain('Forbidden');

    const timedOut = await loadProjectSecrets('t1', async () => {
      throw new Error('Data request timed out (data:get_project_secrets)');
    });
    expect(timedOut.isErr()).toBe(true);
  });

  test('an error answer carries the server message', async () => {
    const loaded = await loadProjectSecrets('t1', async () => ({
      error: 'undecryptable',
      message: 'The project secret API_KEY cannot be decrypted.',
      secretName: 'API_KEY',
    }));
    expect(loaded._unsafeUnwrapErr()).toBe('The project secret API_KEY cannot be decrypted.');
  });

  test('ignores malformed entries and an empty answer', async () => {
    const loaded = await loadProjectSecrets('t1', async () => ({
      secrets: [{ name: 'OK', value: 'v' }, { name: 'NO_VALUE' } as never, null as never],
    }));
    expect(loaded._unsafeUnwrap()).toEqual([{ name: 'OK', value: 'v' }]);
    expect((await loadProjectSecrets('t1', async () => null))._unsafeUnwrap()).toEqual([]);
  });
});

describe('composeAgentEnv', () => {
  test('keeps the base env untouched without secrets', () => {
    expect(composeAgentEnv([], undefined)).toBeUndefined();
    const base = { A: '1' };
    expect(composeAgentEnv([], base)).toBe(base);
  });

  test('puts secrets under the variables funny computed', () => {
    expect(
      composeAgentEnv(
        [
          { name: 'GIT_AUTHOR_NAME', value: 'from-secret' },
          { name: 'DATABASE_URL', value: 'postgres://project' },
        ],
        { GIT_AUTHOR_NAME: 'Real Name' },
      ),
    ).toEqual({ GIT_AUTHOR_NAME: 'Real Name', DATABASE_URL: 'postgres://project' });
  });

  test('secrets alone are an env', () => {
    expect(composeAgentEnv([{ name: 'A', value: '1' }], undefined)).toEqual({ A: '1' });
  });
});

describe('redactDeep', () => {
  test('rewrites every string and keeps the shape', () => {
    const redact = (text: string) => text.replaceAll('hunter2-hunter2', '[secret:PW]');
    const input = {
      type: 'assistant',
      n: 3,
      flag: true,
      nothing: null,
      message: {
        content: [
          { type: 'text', text: 'the password is hunter2-hunter2' },
          { type: 'tool_use', input: { command: 'echo hunter2-hunter2', lines: [1, 'x'] } },
        ],
      },
    };
    expect(redactDeep(input, redact)).toEqual({
      type: 'assistant',
      n: 3,
      flag: true,
      nothing: null,
      message: {
        content: [
          { type: 'text', text: 'the password is [secret:PW]' },
          { type: 'tool_use', input: { command: 'echo [secret:PW]', lines: [1, 'x'] } },
        ],
      },
    });
    expect(input.message.content[0]).toEqual({
      type: 'text',
      text: 'the password is hunter2-hunter2',
    });
  });
});
