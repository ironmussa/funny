import { describe, expect, test } from 'bun:test';

import { setProjectSecretInput } from '../contracts/project-secrets.js';
import { PROVIDER_KEY_REGISTRY } from '../models.js';
import {
  RESERVED_SECRET_NAME_PREFIXES,
  SECRET_NAME_MAX_LENGTH,
  SECRET_VALUE_MAX_BYTES,
  createSecretRedactor,
  validateSecretName,
  validateSecretValue,
} from '../project-secrets.js';

describe('validateSecretName', () => {
  test('accepts an ordinary variable name', () => {
    expect(validateSecretName('DATABASE_URL')).toBeNull();
    expect(validateSecretName('_private1')).toBeNull();
  });

  test.each([
    'PATH',
    'HOME',
    'SHELL',
    'USER',
    'IFS',
    'ENV',
    'BASH_ENV',
    'NODE_OPTIONS',
    'NODE_PATH',
    'PYTHONPATH',
    'PYTHONSTARTUP',
    'GH_TOKEN',
    'GITHUB_TOKEN',
    'TEAM_SERVER_URL',
    'RUNNER_AUTH_SECRET',
    'BROWSER',
    'SSH_AUTH_SOCK',
    'SSH_ASKPASS',
  ])('refuses the reserved name %s', (name) => {
    expect(validateSecretName(name)).toBe('reserved');
  });

  test.each(RESERVED_SECRET_NAME_PREFIXES.map((prefix) => `${prefix}ANYTHING`))(
    'refuses the reserved prefix in %s',
    (name) => {
      expect(validateSecretName(name)).toBe('reserved');
    },
  );

  test('refuses every provider key variable', () => {
    const envVars = PROVIDER_KEY_REGISTRY.flatMap((key) => (key.envVar ? [key.envVar] : []));
    expect(envVars.length).toBeGreaterThan(0);
    for (const envVar of envVars) {
      expect(validateSecretName(envVar)).toBe('reserved');
    }
  });

  test('compares case-insensitively', () => {
    expect(validateSecretName('node_options')).toBe('reserved');
    expect(validateSecretName('Ld_Preload')).toBe('reserved');
  });

  test('refuses names that are not environment variable names', () => {
    expect(validateSecretName('')).toBe('empty');
    expect(validateSecretName('1TOKEN')).toBe('invalid-shape');
    expect(validateSecretName('MY-TOKEN')).toBe('invalid-shape');
    expect(validateSecretName('MY TOKEN')).toBe('invalid-shape');
    expect(validateSecretName('A'.repeat(SECRET_NAME_MAX_LENGTH + 1))).toBe('too-long');
    expect(validateSecretName('A'.repeat(SECRET_NAME_MAX_LENGTH))).toBeNull();
  });
});

describe('validateSecretValue', () => {
  test('refuses an empty and an oversized value, counting bytes', () => {
    expect(validateSecretValue('')).toBe('empty');
    expect(validateSecretValue('x'.repeat(SECRET_VALUE_MAX_BYTES))).toBeNull();
    expect(validateSecretValue('x'.repeat(SECRET_VALUE_MAX_BYTES + 1))).toBe('too-large');
    // 3 bytes each in UTF-8: under the limit in characters, over it in bytes.
    expect(validateSecretValue('€'.repeat(SECRET_VALUE_MAX_BYTES / 2))).toBe('too-large');
  });

  test('accepts a multi-line value', () => {
    expect(validateSecretValue('-----BEGIN KEY-----\nabc\n-----END KEY-----\n')).toBeNull();
  });
});

describe('createSecretRedactor', () => {
  test('returns the input unchanged without secrets', () => {
    expect(createSecretRedactor([])('nothing to hide')).toBe('nothing to hide');
  });

  test('replaces every occurrence of a value', () => {
    const redact = createSecretRedactor([{ name: 'API_KEY', value: 'sk-12345678' }]);
    expect(redact('a sk-12345678 b sk-12345678')).toBe('a [secret:API_KEY] b [secret:API_KEY]');
  });

  test('leaves values shorter than 8 characters alone', () => {
    const redact = createSecretRedactor([{ name: 'PIN', value: '1234567' }]);
    expect(redact('pin 1234567')).toBe('pin 1234567');
  });

  test('replaces the longer value first when one contains another', () => {
    const redact = createSecretRedactor([
      { name: 'SHORT', value: 'abcdefgh' },
      { name: 'LONG', value: 'abcdefgh-ijklmnop' },
    ]);
    expect(redact('x abcdefgh-ijklmnop y abcdefgh z')).toBe('x [secret:LONG] y [secret:SHORT] z');
  });

  test('matches a multi-line value whole and line by line', () => {
    const pem = '-----BEGIN KEY-----\nMIIEvQIBADANBgkq\nshort\n-----END KEY-----';
    const redact = createSecretRedactor([{ name: 'PEM', value: pem }]);
    expect(redact(`key:\n${pem}\ndone`)).toBe('key:\n[secret:PEM]\ndone');
    expect(redact('line MIIEvQIBADANBgkq only')).toBe('line [secret:PEM] only');
    expect(redact('the word short stays')).toBe('the word short stays');
  });
});

describe('setProjectSecretInput', () => {
  const base = { projectId: 'p1', scope: 'project', allowInSandbox: false } as const;

  test('accepts a valid secret, with or without a value', () => {
    expect(setProjectSecretInput.safeParse({ ...base, name: 'API_KEY', value: 'v' }).success).toBe(
      true,
    );
    expect(setProjectSecretInput.safeParse({ ...base, name: 'API_KEY' }).success).toBe(true);
  });

  test('rejects a reserved name, an empty value and an oversized value', () => {
    expect(
      setProjectSecretInput.safeParse({ ...base, name: 'NODE_OPTIONS', value: 'v' }).success,
    ).toBe(false);
    expect(setProjectSecretInput.safeParse({ ...base, name: 'API_KEY', value: '' }).success).toBe(
      false,
    );
    expect(
      setProjectSecretInput.safeParse({
        ...base,
        name: 'API_KEY',
        value: 'x'.repeat(SECRET_VALUE_MAX_BYTES + 1),
      }).success,
    ).toBe(false);
  });
});
