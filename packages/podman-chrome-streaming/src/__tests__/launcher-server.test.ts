import { beforeEach, describe, expect, it, mock } from 'bun:test';

import type {
  LauncherStartRequest,
  LauncherStatus,
  LauncherStopRequest,
  ResolvedLauncherRequest,
} from '../launcher/types.ts';

const getStatusMock = mock(
  (containerName?: string): LauncherStatus => ({
    containerName: containerName || 'funny-remote',
    imageTag: 'funny-runtime:latest',
    exists: true,
    running: true,
    state: 'running',
    funnyUrl: 'http://localhost:3001',
  }),
);

const resolveLauncherRequestMock = mock(
  (input: LauncherStartRequest): ResolvedLauncherRequest => ({
    containerName: input.containerName || 'funny-remote',
    imageTag: 'funny-runtime:latest',
    build: 'if-missing',
    repoMode: input.repoMode || 'clone',
    repoUrl: input.repoUrl,
    repoRef: input.repoRef,
    workBranch: input.workBranch,
    hostRepoPath: input.hostRepoPath,
    gitToken: input.gitToken,
    gitTokenFilePath: input.gitTokenFilePath,
    gitUsername: input.gitUsername || 'x-access-token',
    funnyPort: input.funnyPort || 3001,
    clientOrigin: input.clientOrigin,
    authMode: input.authMode || 'local',
    enableStreaming: input.enableStreaming ?? true,
    streamViewerPort: input.streamViewerPort || 3500,
    streamWsPort: input.streamWsPort || 3501,
    novncPort: input.novncPort || 6080,
    chromeDebugPort: input.chromeDebugPort || 9222,
    startUrl: input.startUrl || 'https://example.com',
  }),
);

const startContainerMock = mock(
  (_config: ResolvedLauncherRequest): LauncherStatus => ({
    containerName: 'funny-remote',
    imageTag: 'funny-runtime:latest',
    exists: true,
    running: true,
    state: 'running',
    funnyUrl: 'http://localhost:3001',
    streamUrl: 'http://localhost:3500',
    novncUrl: 'http://localhost:6080/vnc.html',
    chromeDebugUrl: 'http://localhost:9222',
  }),
);

const stopContainerMock = mock(
  (_input?: LauncherStopRequest): LauncherStatus => ({
    containerName: 'funny-remote',
    imageTag: 'funny-runtime:latest',
    exists: false,
    running: false,
  }),
);

mock.module('../launcher/podman.ts', () => ({
  getStatus: getStatusMock,
  resolveLauncherRequest: resolveLauncherRequestMock,
  startContainer: startContainerMock,
  stopContainer: stopContainerMock,
}));

const { createLauncherFetchHandler, handleStart, handleStatus, handleStop, json, redactRequest } =
  await import('../launcher/server.ts');

beforeEach(() => {
  getStatusMock.mockClear();
  resolveLauncherRequestMock.mockClear();
  startContainerMock.mockClear();
  stopContainerMock.mockClear();

  getStatusMock.mockImplementation((containerName?: string) => ({
    containerName: containerName || 'funny-remote',
    imageTag: 'funny-runtime:latest',
    exists: true,
    running: true,
    state: 'running',
    funnyUrl: 'http://localhost:3001',
  }));

  resolveLauncherRequestMock.mockImplementation((input: LauncherStartRequest) => ({
    containerName: input.containerName || 'funny-remote',
    imageTag: 'funny-runtime:latest',
    build: 'if-missing',
    repoMode: input.repoMode || 'clone',
    repoUrl: input.repoUrl,
    repoRef: input.repoRef,
    workBranch: input.workBranch,
    hostRepoPath: input.hostRepoPath,
    gitToken: input.gitToken,
    gitTokenFilePath: input.gitTokenFilePath,
    gitUsername: input.gitUsername || 'x-access-token',
    funnyPort: input.funnyPort || 3001,
    clientOrigin: input.clientOrigin,
    authMode: input.authMode || 'local',
    enableStreaming: input.enableStreaming ?? true,
    streamViewerPort: input.streamViewerPort || 3500,
    streamWsPort: input.streamWsPort || 3501,
    novncPort: input.novncPort || 6080,
    chromeDebugPort: input.chromeDebugPort || 9222,
    startUrl: input.startUrl || 'https://example.com',
  }));

  startContainerMock.mockImplementation((_config: ResolvedLauncherRequest) => ({
    containerName: 'funny-remote',
    imageTag: 'funny-runtime:latest',
    exists: true,
    running: true,
    state: 'running',
    funnyUrl: 'http://localhost:3001',
    streamUrl: 'http://localhost:3500',
    novncUrl: 'http://localhost:6080/vnc.html',
    chromeDebugUrl: 'http://localhost:9222',
  }));

  stopContainerMock.mockImplementation((_input?: LauncherStopRequest) => ({
    containerName: 'funny-remote',
    imageTag: 'funny-runtime:latest',
    exists: false,
    running: false,
  }));
});

describe('launcher server helpers', () => {
  it('serializes JSON responses with the expected status and content type', async () => {
    const response = json({ ok: true }, 201);

    expect(response.status).toBe(201);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual({ ok: true });
  });

  it('redacts git secrets in the echoed request', () => {
    expect(
      redactRequest({
        repoUrl: 'https://github.com/org/repo.git',
        gitToken: 'secret',
        gitTokenFilePath: '/run/secrets/git_token',
      }),
    ).toEqual({
      repoUrl: 'https://github.com/org/repo.git',
      gitToken: '***',
      gitTokenFilePath: '***',
    });
  });
});

describe('launcher route handlers', () => {
  it('handles start requests and redacts the echoed request body', async () => {
    const request = new Request('http://127.0.0.1:4040/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        repoUrl: 'https://github.com/org/repo.git',
        gitToken: 'secret',
      }),
    });

    const response = await handleStart(request);
    const body = await response.json();

    expect(resolveLauncherRequestMock).toHaveBeenCalled();
    expect(startContainerMock).toHaveBeenCalled();
    expect(body.status).toBe('ready');
    expect(body.request.gitToken).toBe('***');
    expect(body.container.running).toBe(true);
  });

  it('handles stop requests', async () => {
    const request = new Request('http://127.0.0.1:4040/stop', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ containerName: 'funny-remote', remove: true }),
    });

    const response = await handleStop(request);
    const body = await response.json();

    expect(stopContainerMock).toHaveBeenCalledWith({
      containerName: 'funny-remote',
      remove: true,
    });
    expect(body.status).toBe('stopped');
  });

  it('handles status requests and derives running state', async () => {
    getStatusMock.mockImplementation(() => ({
      containerName: 'funny-remote',
      imageTag: 'funny-runtime:latest',
      exists: true,
      running: false,
      state: 'exited',
    }));

    const request = new Request('http://127.0.0.1:4040/status?containerName=funny-remote');

    const response = handleStatus(request);
    const body = await response.json();

    expect(getStatusMock).toHaveBeenCalledWith('funny-remote');
    expect(body.status).toBe('stopped');
    expect(body.container.state).toBe('exited');
  });
});

describe('createLauncherFetchHandler', () => {
  it('serves the health route', async () => {
    const fetchHandler = createLauncherFetchHandler();
    const response = await fetchHandler(new Request('http://127.0.0.1:4040/health'));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      service: 'podman-launcher',
    });
  });

  it('serves the status route', async () => {
    const fetchHandler = createLauncherFetchHandler();
    const response = await fetchHandler(
      new Request('http://127.0.0.1:4040/status?containerName=funny-remote'),
    );
    const body = await response.json();

    expect(body.status).toBe('running');
    expect(body.container.containerName).toBe('funny-remote');
  });

  it('returns route help on unknown paths', async () => {
    const fetchHandler = createLauncherFetchHandler();
    const response = await fetchHandler(new Request('http://127.0.0.1:4040/missing'));
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error).toBe('Not found');
    expect(body.routes.start).toBe('POST /start');
  });

  it('returns 500 when a route handler throws', async () => {
    resolveLauncherRequestMock.mockImplementation(() => {
      throw new Error('bad request');
    });

    const fetchHandler = createLauncherFetchHandler();
    const response = await fetchHandler(
      new Request('http://127.0.0.1:4040/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ repoMode: 'clone' }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error).toBe('bad request');
  });
});
