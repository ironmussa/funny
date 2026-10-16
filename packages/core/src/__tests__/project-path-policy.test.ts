import { mkdtempSync, rmSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { resolveProjectPathPolicy, validateProjectRootPath } from '../git/path-validation.js';

describe('project path deployment policy', () => {
  test('defaults to local for the local server and its loopback runner', () => {
    expect(resolveProjectPathPolicy({})).toBe('local');
    expect(resolveProjectPathPolicy({ TEAM_SERVER_URL: 'http://127.0.0.1:5002' })).toBe('local');
    expect(resolveProjectPathPolicy({ HOST: '::1' })).toBe('local');
  });

  test('restricts exposed, shared, remote and unrecognized configurations', () => {
    for (const env of [
      { FUNNY_PROJECT_ROOT: '/data/repos' },
      { HOST: '0.0.0.0' },
      { HOST: '::' },
      { AUTH_MODE: 'multi' },
      { AUTH_MODE: 'unknown' },
      { TEAM_SERVER_URL: 'https://team.example.com' },
      { TEAM_SERVER_URL: 'http://localhost.example.com' },
      { TEAM_SERVER_URL: 'invalid' },
      { FUNNY_PROJECT_PATH_POLICY: 'typo' },
      { FUNNY_PROJECT_PATH_POLICY: 'restricted' },
    ]) {
      expect(resolveProjectPathPolicy(env)).toBe('restricted');
    }
  });

  test('lets the operator explicitly configure a personal installation', () => {
    expect(
      resolveProjectPathPolicy({
        HOST: '0.0.0.0',
        FUNNY_PROJECT_PATH_POLICY: 'local',
      }),
    ).toBe('local');
  });
});

describe('local project locations', () => {
  const savedPolicy = process.env.FUNNY_PROJECT_PATH_POLICY;
  const savedRoot = process.env.FUNNY_PROJECT_ROOT;

  beforeEach(() => {
    process.env.FUNNY_PROJECT_PATH_POLICY = 'local';
    delete process.env.FUNNY_PROJECT_ROOT;
  });

  afterEach(() => {
    if (savedPolicy === undefined) delete process.env.FUNNY_PROJECT_PATH_POLICY;
    else process.env.FUNNY_PROJECT_PATH_POLICY = savedPolicy;
    if (savedRoot === undefined) delete process.env.FUNNY_PROJECT_ROOT;
    else process.env.FUNNY_PROJECT_ROOT = savedRoot;
  });

  test('accepts mounted repositories without a per-directory allowlist', () => {
    expect(validateProjectRootPath('/mnt/windows/Users/owner/code/project').isOk()).toBe(true);
    expect(validateProjectRootPath('/media/external/project').isOk()).toBe(true);
  });

  test('retains lexical and system-directory guards', () => {
    for (const path of ['/etc', '/proc', '/root/.ssh', '../repo', '/mnt/../etc', '-rf']) {
      expect(validateProjectRootPath(path).isErr()).toBe(true);
    }
  });

  test('still rejects a symlink into a system directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'funny-path-policy-'));
    try {
      symlinkSync('/etc', join(dir, 'repo'));
      expect(validateProjectRootPath(join(dir, 'repo')).isErr()).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
