import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { getPackagePaths, getStatus, resolveLauncherRequest } from '../launcher/podman.ts';

type SpawnResult = {
  exitCode: number;
  stdout?: string;
  stderr?: string;
};

const originalSpawnSync = Bun.spawnSync;

function createSpawnMock(results: SpawnResult[]) {
  let callIndex = 0;

  return ((options: { cmd: string[] }) => {
    const next = results[callIndex++];
    if (!next) {
      throw new Error(`Unexpected Bun.spawnSync call: ${options.cmd.join(' ')}`);
    }

    return {
      exitCode: next.exitCode,
      stdout: next.stdout ?? '',
      stderr: next.stderr ?? '',
    } as any;
  }) as typeof Bun.spawnSync;
}

beforeEach(() => {
  (Bun as any).spawnSync = originalSpawnSync;
});

afterEach(() => {
  (Bun as any).spawnSync = originalSpawnSync;
});

describe('resolveLauncherRequest', () => {
  it('fills defaults for a clone request', () => {
    const resolved = resolveLauncherRequest({
      repoUrl: 'https://github.com/org/repo.git',
    });

    expect(resolved).toEqual({
      containerName: 'funny-remote',
      imageTag: 'funny-runtime:latest',
      build: 'if-missing',
      repoMode: 'clone',
      repoUrl: 'https://github.com/org/repo.git',
      repoRef: undefined,
      workBranch: undefined,
      hostRepoPath: undefined,
      gitToken: undefined,
      gitTokenFilePath: undefined,
      gitUsername: 'x-access-token',
      funnyPort: 3001,
      clientOrigin: undefined,
      authMode: 'local',
      enableStreaming: true,
      streamViewerPort: 3500,
      streamWsPort: 3501,
      novncPort: 6080,
      chromeDebugPort: 9222,
      startUrl: 'https://example.com',
    });
  });

  it('throws when clone mode does not provide repoUrl', () => {
    expect(() => resolveLauncherRequest({ repoMode: 'clone' })).toThrow(
      '`repoUrl` is required when `repoMode` is `clone`.',
    );
  });

  it('throws when mount mode does not provide hostRepoPath', () => {
    expect(() => resolveLauncherRequest({ repoMode: 'mount' })).toThrow(
      '`hostRepoPath` is required when `repoMode` is `mount`.',
    );
  });

  it('keeps explicit values for mount mode', () => {
    const resolved = resolveLauncherRequest({
      repoMode: 'mount',
      hostRepoPath: 'C:\\repos\\demo',
      funnyPort: 4101,
      enableStreaming: false,
      authMode: 'multi',
      build: 'never',
    });

    expect(resolved.repoMode).toBe('mount');
    expect(resolved.hostRepoPath).toBe('C:\\repos\\demo');
    expect(resolved.funnyPort).toBe(4101);
    expect(resolved.enableStreaming).toBe(false);
    expect(resolved.authMode).toBe('multi');
    expect(resolved.build).toBe('never');
  });
});

describe('getStatus', () => {
  it('returns a missing container status when inspect fails', () => {
    (Bun as any).spawnSync = createSpawnMock([
      { exitCode: 0, stdout: JSON.stringify([{ Running: true }]) },
      { exitCode: 125, stdout: '', stderr: 'no such container' },
    ]);

    const status = getStatus('missing-container');

    expect(status).toEqual({
      containerName: 'missing-container',
      imageTag: 'funny-runtime:latest',
      exists: false,
      running: false,
    });
  });

  it('returns parsed status and host URLs for a running container', () => {
    (Bun as any).spawnSync = createSpawnMock([
      { exitCode: 0, stdout: JSON.stringify([{ Running: true }]) },
      {
        exitCode: 0,
        stdout: JSON.stringify([
          {
            State: {
              Running: true,
              Status: 'running',
            },
          },
        ]),
      },
      { exitCode: 0, stdout: '[]' },
      {
        exitCode: 0,
        stdout: '2: eth0    inet 172.25.137.72/20 brd 172.25.143.255 scope global eth0\n',
      },
    ]);

    const status = getStatus('funny-remote-smoke', 'funny-runtime:latest', {
      funnyPort: 3101,
      streamViewerPort: 3600,
      novncPort: 6180,
      chromeDebugPort: 9322,
      enableStreaming: true,
    });

    expect(status).toEqual({
      containerName: 'funny-remote-smoke',
      imageTag: 'funny-runtime:latest',
      exists: true,
      running: true,
      state: 'running',
      machineIp: '172.25.137.72',
      funnyUrl: 'http://localhost:3101',
      streamUrl: 'http://localhost:3600',
      novncUrl: 'http://localhost:6180/vnc.html',
      chromeDebugUrl: 'http://localhost:9322',
      funnyMachineUrl: 'http://172.25.137.72:3101',
      streamMachineUrl: 'http://172.25.137.72:3600',
      novncMachineUrl: 'http://172.25.137.72:6180/vnc.html',
      chromeDebugMachineUrl: 'http://172.25.137.72:9322',
    });
  });

  it('omits streaming URLs when streaming is disabled', () => {
    (Bun as any).spawnSync = createSpawnMock([
      { exitCode: 0, stdout: JSON.stringify([{ Running: true }]) },
      {
        exitCode: 0,
        stdout: JSON.stringify([
          {
            State: {
              Running: false,
              Status: 'exited',
            },
          },
        ]),
      },
      { exitCode: 0, stdout: '[]' },
      {
        exitCode: 0,
        stdout: '2: eth0    inet 172.25.137.72/20 brd 172.25.143.255 scope global eth0\n',
      },
    ]);

    const status = getStatus('funny-headless-off', 'funny-runtime:latest', {
      funnyPort: 3001,
      enableStreaming: false,
    });

    expect(status).toEqual({
      containerName: 'funny-headless-off',
      imageTag: 'funny-runtime:latest',
      exists: true,
      running: false,
      state: 'exited',
      machineIp: '172.25.137.72',
      funnyUrl: 'http://localhost:3001',
      streamUrl: undefined,
      novncUrl: undefined,
      chromeDebugUrl: undefined,
      funnyMachineUrl: 'http://172.25.137.72:3001',
      streamMachineUrl: undefined,
      novncMachineUrl: undefined,
      chromeDebugMachineUrl: undefined,
    });
  });
});

describe('getPackagePaths', () => {
  it('returns the package and workspace directories', () => {
    const paths = getPackagePaths();

    expect(paths.packageDir.endsWith('packages\\podman-chrome-streaming')).toBe(true);
    expect(paths.workspaceRoot.endsWith('a-parallel')).toBe(true);
  });
});
