import { resolve } from 'path';

import type {
  LauncherStartRequest,
  LauncherStatus,
  LauncherStopRequest,
  ResolvedLauncherRequest,
} from './types.ts';

const DEFAULT_CONTAINER_NAME = 'funny-remote';
const DEFAULT_IMAGE_TAG = 'funny-runtime:latest';
const PACKAGE_DIR = resolve(import.meta.dir, '..', '..');
const WORKSPACE_ROOT = resolve(PACKAGE_DIR, '..', '..');

export function ensurePodmanReady() {
  if (process.platform !== 'win32') return;

  const inspect = runPodman(['machine', 'list', '--format', 'json'], {
    capture: true,
    allowFailure: true,
  });

  if (!inspect.ok) {
    startPodmanMachine();
    return;
  }

  let machines: Array<{ Running?: boolean }> = [];
  try {
    machines = JSON.parse(inspect.stdout || '[]');
  } catch {
    startPodmanMachine();
    return;
  }

  if (!machines.some((machine) => machine?.Running === true)) {
    startPodmanMachine();
  }
}

export function resolveLauncherRequest(input: LauncherStartRequest): ResolvedLauncherRequest {
  const repoMode = input.repoMode ?? 'clone';
  if (repoMode === 'clone' && !input.repoUrl) {
    throw new Error('`repoUrl` is required when `repoMode` is `clone`.');
  }
  if (repoMode === 'mount' && !input.hostRepoPath) {
    throw new Error('`hostRepoPath` is required when `repoMode` is `mount`.');
  }

  return {
    containerName: input.containerName || DEFAULT_CONTAINER_NAME,
    imageTag: input.imageTag || DEFAULT_IMAGE_TAG,
    build: input.build || 'if-missing',
    repoMode,
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
  };
}

export function ensureImage(config: ResolvedLauncherRequest) {
  if (config.build === 'never') return;

  if (config.build === 'if-missing') {
    const exists = runPodman(['image', 'exists', config.imageTag], { allowFailure: true });
    if (exists.ok) return;
  }

  const tagParts = config.imageTag.includes(':')
    ? ['-t', config.imageTag]
    : ['-t', `${config.imageTag}:latest`];
  const build = runPodman(['build', ...tagParts, '-f', 'Containerfile', '../..'], {
    cwd: PACKAGE_DIR,
    allowFailure: true,
  });
  if (!build.ok) {
    throw new Error(`Failed to build image ${config.imageTag}.`);
  }
}

export function startContainer(config: ResolvedLauncherRequest): LauncherStatus {
  ensurePodmanReady();
  ensureImage(config);

  const args = [
    'run',
    '-d',
    '--name',
    config.containerName,
    '--replace',
    '-p',
    `${config.funnyPort}:${config.funnyPort}`,
  ];

  if (config.enableStreaming) {
    args.push(
      '-p',
      `${config.streamViewerPort}:${config.streamViewerPort}`,
      '-p',
      `${config.streamWsPort}:${config.streamWsPort}`,
      '-p',
      `${config.novncPort}:${config.novncPort}`,
      '-p',
      `${config.chromeDebugPort}:${config.chromeDebugPort}`,
    );
  }

  args.push(
    '--shm-size=2g',
    '--security-opt',
    'seccomp=unconfined',
    '-e',
    'ENABLE_RUNTIME=true',
    '-e',
    `ENABLE_STREAMING=${String(config.enableStreaming)}`,
    '-e',
    `REPO_MODE=${config.repoMode}`,
    '-e',
    `FUNNY_PORT=${config.funnyPort}`,
    '-e',
    `AUTH_MODE=${config.authMode}`,
    '-e',
    `GIT_USERNAME=${config.gitUsername}`,
    '-e',
    `START_URL=${config.startUrl}`,
    '-e',
    `STREAM_HTTP_PORT=${config.streamViewerPort}`,
    '-e',
    `STREAM_WS_PORT=${config.streamWsPort}`,
    '-e',
    `NOVNC_PORT=${config.novncPort}`,
    '-e',
    `CHROME_DEBUG_PORT=${config.chromeDebugPort}`,
  );

  if (config.repoUrl) args.push('-e', `REPO_URL=${config.repoUrl}`);
  if (config.repoRef) args.push('-e', `REPO_REF=${config.repoRef}`);
  if (config.workBranch) args.push('-e', `WORK_BRANCH=${config.workBranch}`);
  if (config.clientOrigin) args.push('-e', `CLIENT_ORIGIN=${config.clientOrigin}`);
  if (config.gitToken) args.push('-e', `GIT_TOKEN=${config.gitToken}`);

  if (config.gitTokenFilePath) {
    args.push('-v', `${normalizePath(config.gitTokenFilePath)}:/run/secrets/git_token:ro`);
    args.push('-e', 'GIT_TOKEN_FILE=/run/secrets/git_token');
  }

  if (config.repoMode === 'mount' && config.hostRepoPath) {
    args.push('-v', `${normalizePath(config.hostRepoPath)}:/workspace/repo`);
  }

  args.push(config.imageTag);

  const start = runPodman(args, { allowFailure: true });
  if (!start.ok) {
    throw new Error(`Failed to start container ${config.containerName}.`);
  }

  return getStatus(config.containerName, config.imageTag, config);
}

export function stopContainer(input: LauncherStopRequest = {}): LauncherStatus {
  ensurePodmanReady();

  const containerName = input.containerName || DEFAULT_CONTAINER_NAME;
  const remove = input.remove ?? true;
  runPodman(['stop', containerName], { allowFailure: true });
  if (remove) {
    runPodman(['rm', '-f', containerName], { allowFailure: true });
  }
  return getStatus(containerName);
}

export function getStatus(
  containerName = DEFAULT_CONTAINER_NAME,
  imageTag = DEFAULT_IMAGE_TAG,
  request?: Partial<ResolvedLauncherRequest>,
): LauncherStatus {
  ensurePodmanReady();

  const inspect = runPodman(['inspect', containerName, '--format', 'json'], {
    capture: true,
    allowFailure: true,
  });

  if (!inspect.ok || !inspect.stdout.trim()) {
    return {
      containerName,
      imageTag,
      exists: false,
      running: false,
    };
  }

  let parsed: any[] = [];
  try {
    parsed = JSON.parse(inspect.stdout);
  } catch {
    return {
      containerName,
      imageTag,
      exists: true,
      running: false,
      state: 'unknown',
    };
  }

  const container = parsed[0];
  const running = container?.State?.Running === true;
  const funnyPort = request?.funnyPort || 3001;
  const streamViewerPort = request?.streamViewerPort || 3500;
  const novncPort = request?.novncPort || 6080;
  const chromeDebugPort = request?.chromeDebugPort || 9222;
  const machineIp = resolveMachineIp();

  return {
    containerName,
    imageTag,
    exists: true,
    running,
    state: container?.State?.Status || 'unknown',
    machineIp,
    funnyUrl: `http://localhost:${funnyPort}`,
    streamUrl:
      request?.enableStreaming === false ? undefined : `http://localhost:${streamViewerPort}`,
    novncUrl:
      request?.enableStreaming === false ? undefined : `http://localhost:${novncPort}/vnc.html`,
    chromeDebugUrl:
      request?.enableStreaming === false ? undefined : `http://localhost:${chromeDebugPort}`,
    funnyMachineUrl: machineIp ? `http://${machineIp}:${funnyPort}` : undefined,
    streamMachineUrl:
      request?.enableStreaming === false || !machineIp
        ? undefined
        : `http://${machineIp}:${streamViewerPort}`,
    novncMachineUrl:
      request?.enableStreaming === false || !machineIp
        ? undefined
        : `http://${machineIp}:${novncPort}/vnc.html`,
    chromeDebugMachineUrl:
      request?.enableStreaming === false || !machineIp
        ? undefined
        : `http://${machineIp}:${chromeDebugPort}`,
  };
}

function startPodmanMachine() {
  const start = runPodman(['machine', 'start'], { allowFailure: true });
  if (start.ok) return;

  const init = runPodman(['machine', 'init'], { allowFailure: true });
  if (!init.ok) {
    throw new Error('Unable to initialize Podman machine.');
  }

  const retry = runPodman(['machine', 'start'], { allowFailure: true });
  if (!retry.ok) {
    throw new Error('Unable to start Podman machine.');
  }
}

function resolveMachineIp(): string | undefined {
  if (process.platform !== 'win32') return undefined;

  const inspect = runPodman(['machine', 'inspect'], {
    capture: true,
    allowFailure: true,
  });
  if (!inspect.ok) return undefined;

  const ipResult = runPodman(
    ['machine', 'ssh', 'ip', '-4', '-o', 'addr', 'show', 'scope', 'global'],
    { capture: true, allowFailure: true },
  );
  if (!ipResult.ok || !ipResult.stdout.trim()) return undefined;

  for (const line of ipResult.stdout.split(/\r?\n/)) {
    const match = line.match(/\binet\s+(\d+\.\d+\.\d+\.\d+)\//);
    if (match && match[1] !== '127.0.0.1') {
      return match[1];
    }
  }

  return undefined;
}

function runPodman(
  args: string[],
  options: {
    cwd?: string;
    capture?: boolean;
    allowFailure?: boolean;
  } = {},
) {
  const result = Bun.spawnSync({
    cmd: ['podman', ...args],
    cwd: options.cwd ?? PACKAGE_DIR,
    env: process.env,
    stdin: 'inherit',
    stdout: options.capture ? 'pipe' : 'inherit',
    stderr: options.capture ? 'pipe' : 'inherit',
  });

  const ok = result.exitCode === 0;
  const output = options.capture ? Buffer.from(result.stdout ?? '').toString('utf-8') : '';
  const error = options.capture ? Buffer.from(result.stderr ?? '').toString('utf-8') : '';

  if (!ok && !options.allowFailure) {
    throw new Error(error || output || `podman ${args.join(' ')} failed`);
  }

  return {
    ok,
    status: result.exitCode ?? 1,
    stdout: output,
    stderr: error,
  };
}

function normalizePath(value: string): string {
  if (process.platform !== 'win32') return value;
  return value.replace(/\\/g, '/');
}

export function getPackagePaths() {
  return {
    packageDir: PACKAGE_DIR,
    workspaceRoot: WORKSPACE_ROOT,
  };
}
