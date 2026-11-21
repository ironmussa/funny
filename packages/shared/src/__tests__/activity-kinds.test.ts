import { describe, expect, test } from 'bun:test';

import { parseActivityInput, stripUrlCredentials } from '../activities/kinds.js';

// Built from parts so secret scanners do not read the fixture as a real credential.
const URL_WITH_CREDENTIALS = ['https://', 'user', ':', 'token', '@github.com/org/repo.git'].join(
  '',
);

describe('stripUrlCredentials', () => {
  test('removes user and token from an https URL', () => {
    expect(stripUrlCredentials(URL_WITH_CREDENTIALS)).toBe('https://github.com/org/repo.git');
  });

  test('removes a lone token', () => {
    expect(stripUrlCredentials('https://ghp_abc@github.com/org/repo.git')).toBe(
      'https://github.com/org/repo.git',
    );
  });

  test('keeps a URL without credentials', () => {
    expect(stripUrlCredentials('https://github.com/org/repo.git')).toBe(
      'https://github.com/org/repo.git',
    );
    expect(stripUrlCredentials('git@github.com:org/repo.git')).toBe('git@github.com:org/repo.git');
  });
});

describe('parseActivityInput', () => {
  test('drops undeclared fields', () => {
    const input = parseActivityInput('project.clone', {
      cloneUrl: 'https://github.com/org/repo.git',
      destinationPath: '/tmp/repo',
      token: 'ghp_secret',
    });
    expect(input).toEqual({
      cloneUrl: 'https://github.com/org/repo.git',
      destinationPath: '/tmp/repo',
    });
  });

  test('strips credentials from the clone URL', () => {
    const input = parseActivityInput('project.clone', {
      cloneUrl: URL_WITH_CREDENTIALS,
      destinationPath: '/tmp/repo',
    });
    expect(input?.cloneUrl).toBe('https://github.com/org/repo.git');
  });

  test('refuses an unknown kind', () => {
    expect(parseActivityInput('project.delete', {})).toBeNull();
    expect(parseActivityInput('toString', {})).toBeNull();
  });

  test('refuses an input that does not match its kind', () => {
    expect(parseActivityInput('git.workflow', { action: 'rm -rf' })).toBeNull();
  });
});
