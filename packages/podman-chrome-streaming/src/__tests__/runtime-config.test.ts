import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';

import {
  buildAuthenticatedUrl,
  configFromEnv,
  redactGitUrl,
  resolveGitCredentials,
} from '../runtime/config.ts';
import type { RuntimeConfig } from '../runtime/types.ts';

const TMP_DIR = join(import.meta.dir, '..', '..', '.test-tmp-runtime-config');
const ORIGINAL_ENV = { ...process.env };

function restoreEnv() {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) {
      delete process.env[key];
    }
  }

  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function createBaseConfig(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return {
    repoMode: 'clone',
    repoUrl: 'https://github.com/example/repo.git',
    repoRef: undefined,
    workBranch: undefined,
    gitToken: undefined,
    gitTokenFile: undefined,
    gitUsername: 'x-access-token',
    workspacePath: '/workspace/repo',
    funnyPort: 3001,
    clientOrigin: undefined,
    authMode: 'local',
    funnyDataDir: '/workspace/.funny-data',
    enableRuntime: true,
    enableStreaming: true,
    streamViewerPort: 3500,
    streamWsPort: 3501,
    novncPort: 6080,
    chromeDebugPort: 9222,
    startUrl: 'https://example.com',
    ...overrides,
  };
}

beforeEach(() => {
  restoreEnv();
  rmSync(TMP_DIR, { recursive: true, force: true });
  mkdirSync(TMP_DIR, { recursive: true });
});

afterEach(() => {
  restoreEnv();
  rmSync(TMP_DIR, { recursive: true, force: true });
});

describe('configFromEnv', () => {
  it('throws when runtime clone mode is enabled without REPO_URL', () => {
    delete process.env.REPO_URL;
    delete process.env.ENABLE_RUNTIME;
    process.env.REPO_MODE = 'clone';

    expect(() => configFromEnv()).toThrow(
      'REPO_URL environment variable is required when REPO_MODE=clone',
    );
  });

  it('allows missing REPO_URL when runtime is disabled', () => {
    delete process.env.REPO_URL;
    process.env.ENABLE_RUNTIME = 'false';

    const config = configFromEnv();

    expect(config.enableRuntime).toBe(false);
    expect(config.repoUrl).toBeUndefined();
    expect(config.repoMode).toBe('clone');
  });

  it('parses defaults, booleans, numbers, and legacy port environment variables', () => {
    process.env.REPO_URL = 'https://github.com/org/repo.git';
    process.env.REPO_REF = 'main';
    process.env.WORK_BRANCH = 'feature/demo';
    process.env.GIT_TOKEN = 'secret-token';
    process.env.GIT_USERNAME = 'custom-user';
    process.env.WORKSPACE_PATH = '/tmp/workspace';
    process.env.FUNNY_PORT = '4100';
    process.env.CLIENT_ORIGIN = 'http://localhost:5173';
    process.env.AUTH_MODE = 'multi';
    process.env.FUNNY_DATA_DIR = '/tmp/funny-data';
    process.env.ENABLE_RUNTIME = 'true';
    process.env.ENABLE_STREAMING = 'off';
    process.env.HTTP_PORT = '4400';
    process.env.WS_PORT = '4401';
    process.env.NOVNC_PORT = '6680';
    process.env.CHROME_PORT = '9922';
    process.env.START_URL = 'https://news.ycombinator.com';

    const config = configFromEnv();

    expect(config).toMatchObject({
      repoMode: 'clone',
      repoUrl: 'https://github.com/org/repo.git',
      repoRef: 'main',
      workBranch: 'feature/demo',
      gitToken: 'secret-token',
      gitUsername: 'custom-user',
      workspacePath: '/tmp/workspace',
      funnyPort: 4100,
      clientOrigin: 'http://localhost:5173',
      authMode: 'multi',
      funnyDataDir: '/tmp/funny-data',
      enableRuntime: true,
      enableStreaming: false,
      streamViewerPort: 4400,
      streamWsPort: 4401,
      novncPort: 6680,
      chromeDebugPort: 9922,
      startUrl: 'https://news.ycombinator.com',
    });
  });

  it('falls back to default values for invalid numbers', () => {
    process.env.REPO_URL = 'https://github.com/org/repo.git';
    process.env.FUNNY_PORT = 'not-a-number';
    process.env.STREAM_HTTP_PORT = 'bad';
    process.env.STREAM_WS_PORT = 'bad';
    process.env.NOVNC_PORT = 'bad';
    process.env.CHROME_DEBUG_PORT = 'bad';

    const config = configFromEnv();

    expect(config.funnyPort).toBe(3001);
    expect(config.streamViewerPort).toBe(3500);
    expect(config.streamWsPort).toBe(3501);
    expect(config.novncPort).toBe(6080);
    expect(config.chromeDebugPort).toBe(9222);
  });
});

describe('resolveGitCredentials', () => {
  it('prefers GIT_TOKEN_FILE over GIT_TOKEN and trims the file contents', () => {
    const tokenFile = join(TMP_DIR, 'token.txt');
    writeFileSync(tokenFile, 'file-token\n');

    const credentials = resolveGitCredentials(
      createBaseConfig({
        gitToken: 'env-token',
        gitTokenFile: tokenFile,
      }),
    );

    expect(credentials).toEqual({
      token: 'file-token',
      username: 'x-access-token',
    });
  });

  it('returns null when no token is provided', () => {
    const credentials = resolveGitCredentials(
      createBaseConfig({
        gitToken: undefined,
        gitTokenFile: undefined,
      }),
    );

    expect(credentials).toBeNull();
  });

  it('throws when GIT_TOKEN_FILE points to a missing file', () => {
    expect(() =>
      resolveGitCredentials(
        createBaseConfig({
          gitTokenFile: join(TMP_DIR, 'missing-token.txt'),
        }),
      ),
    ).toThrow('GIT_TOKEN_FILE not found');
  });
});

describe('git URL helpers', () => {
  it('builds an authenticated URL with username and token', () => {
    const url = buildAuthenticatedUrl('https://github.com/org/repo.git', {
      username: 'x-access-token',
      token: 'test-tok',
    });

    expect(url).toBe(`https://x-access-token:${'test-tok'}@github.com/org/repo.git`);
  });

  it('redacts credentials in logged URLs', () => {
    const redacted = redactGitUrl(`https://x-access-token:${'test-tok'}@github.com/org/repo.git`);

    expect(redacted).toBe('https://***:***@github.com/org/repo.git');
  });
});
