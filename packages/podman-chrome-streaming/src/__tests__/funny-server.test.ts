import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';

import {
  startFunnyServer,
  stopFunnyServer,
  waitForFunnyServerExit,
} from '../runtime/funny-server.ts';
import type { RuntimeConfig } from '../runtime/types.ts';

const TMP_DIR = join(import.meta.dir, '..', '..', '.test-tmp-funny-server');
const originalSpawn = Bun.spawn;

function createBaseConfig(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return {
    repoMode: 'clone',
    repoUrl: 'https://github.com/org/repo.git',
    repoRef: undefined,
    workBranch: undefined,
    gitToken: undefined,
    gitTokenFile: undefined,
    gitUsername: 'x-access-token',
    workspacePath: join(TMP_DIR, 'workspace'),
    funnyPort: 3001,
    clientOrigin: undefined,
    authMode: 'local',
    funnyDataDir: join(TMP_DIR, 'data'),
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

function createFakeProcess() {
  let resolveExit!: (value: number) => void;
  const kills: string[] = [];
  const exited = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });

  return {
    process: {
      exited,
      kill(signal: string) {
        kills.push(signal);
        resolveExit(signal === 'SIGKILL' ? 137 : 0);
      },
    } as any,
    kills,
    resolveExit,
  };
}

beforeEach(() => {
  rmSync(TMP_DIR, { recursive: true, force: true });
  mkdirSync(TMP_DIR, { recursive: true });
  (Bun as any).spawn = originalSpawn;
});

afterEach(async () => {
  await stopFunnyServer();
  (Bun as any).spawn = originalSpawn;
  rmSync(TMP_DIR, { recursive: true, force: true });
});

describe('startFunnyServer', () => {
  it('spawns the published Funny server binary with the expected environment', async () => {
    const tokenFile = join(TMP_DIR, 'gh-token.txt');
    writeFileSync(tokenFile, 'gh-secret-token\n');

    const fake = createFakeProcess();
    const spawnCalls: Array<{ cmd: string[]; env: Record<string, string>; cwd: string }> = [];

    (Bun as any).spawn = ((cmd: string[], options: any) => {
      spawnCalls.push({
        cmd,
        env: options.env,
        cwd: options.cwd,
      });
      return fake.process;
    }) as typeof Bun.spawn;

    await startFunnyServer({
      workspacePath: join(TMP_DIR, 'workspace'),
      config: createBaseConfig({
        funnyPort: 3101,
        authMode: 'multi',
        clientOrigin: 'http://localhost:5173',
        funnyDataDir: join(TMP_DIR, 'data'),
        gitTokenFile: tokenFile,
      }),
    });

    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]).toMatchObject({
      cmd: ['/opt/funny-server-runtime/node_modules/.bin/funny-server'],
      cwd: join(TMP_DIR, 'workspace'),
    });
    expect(spawnCalls[0].env.PORT).toBe('3101');
    expect(spawnCalls[0].env.HOST).toBe('0.0.0.0');
    expect(spawnCalls[0].env.AUTH_MODE).toBe('multi');
    expect(spawnCalls[0].env.CORS_ORIGIN).toBe('http://localhost:5173');
    expect(spawnCalls[0].env.CLIENT_PORT).toBe('5173');
    expect(spawnCalls[0].env.FUNNY_DATA_DIR).toBe(join(TMP_DIR, 'data'));
    expect(spawnCalls[0].env.GH_TOKEN).toBe('gh-secret-token');

    fake.resolveExit(0);
    await waitForFunnyServerExit();
  });

  it('does not spawn a second process when one is already running', async () => {
    const first = createFakeProcess();
    let spawnCount = 0;

    (Bun as any).spawn = ((_: string[], __: any) => {
      spawnCount += 1;
      return first.process;
    }) as typeof Bun.spawn;

    const options = {
      workspacePath: join(TMP_DIR, 'workspace'),
      config: createBaseConfig(),
    };

    await startFunnyServer(options);
    await startFunnyServer(options);

    expect(spawnCount).toBe(1);

    first.resolveExit(0);
    await waitForFunnyServerExit();
  });

  it('omits CLIENT_PORT when clientOrigin is not a valid URL', async () => {
    const fake = createFakeProcess();
    let capturedEnv: Record<string, string> | undefined;

    (Bun as any).spawn = ((_: string[], options: any) => {
      capturedEnv = options.env;
      return fake.process;
    }) as typeof Bun.spawn;

    await startFunnyServer({
      workspacePath: join(TMP_DIR, 'workspace'),
      config: createBaseConfig({
        clientOrigin: 'not-a-valid-url',
      }),
    });

    expect(capturedEnv?.CORS_ORIGIN).toBe('not-a-valid-url');
    expect(capturedEnv?.CLIENT_PORT).toBeUndefined();

    fake.resolveExit(0);
    await waitForFunnyServerExit();
  });
});

describe('waitForFunnyServerExit', () => {
  it('returns null when no process is running', async () => {
    await expect(waitForFunnyServerExit()).resolves.toBeNull();
  });
});

describe('stopFunnyServer', () => {
  it('kills the running process with SIGTERM and clears state', async () => {
    const fake = createFakeProcess();

    (Bun as any).spawn = ((_: string[], __: any) => fake.process) as typeof Bun.spawn;

    await startFunnyServer({
      workspacePath: join(TMP_DIR, 'workspace'),
      config: createBaseConfig(),
    });

    await stopFunnyServer();

    expect(fake.kills).toEqual(['SIGTERM']);
    await expect(waitForFunnyServerExit()).resolves.toBeNull();
  });

  it('does nothing when there is no running process', async () => {
    await expect(stopFunnyServer()).resolves.toBeUndefined();
  });
});
