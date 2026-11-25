import { describe, expect, test } from 'bun:test';

import type { RunnerBuild } from '../runner-build.js';
import { runnerInstallEnv } from '../runner-install-script.js';

const build: RunnerBuild = {
  commit: 'a'.repeat(40),
  version: 'aaaaaaa',
  repoUrl: 'https://github.com/ironmussa/funny.git',
};

describe('runnerInstallEnv', () => {
  test('passes the repository and commit, in that order', () => {
    expect(Object.entries(runnerInstallEnv(build))).toEqual([
      ['FUNNY_REPO_URL', build.repoUrl],
      ['FUNNY_COMMIT', build.commit],
    ]);
  });

  test('asks for the native build last, only when requested', () => {
    expect(Object.entries(runnerInstallEnv(build, { buildNative: true }))).toEqual([
      ['FUNNY_REPO_URL', build.repoUrl],
      ['FUNNY_COMMIT', build.commit],
      ['FUNNY_BUILD_NATIVE', '1'],
    ]);
    expect(runnerInstallEnv(build, { buildNative: false })).not.toHaveProperty(
      'FUNNY_BUILD_NATIVE',
    );
  });
});
