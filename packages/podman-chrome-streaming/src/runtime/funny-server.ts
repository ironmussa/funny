import { existsSync } from 'fs';

import type { Subprocess } from 'bun';

import { resolveGitCredentials } from './config.ts';
import type { RuntimeConfig } from './types.ts';

const SERVER_BIN_CANDIDATES = [
  '/opt/funny-server-runtime/node_modules/.bin/funny-server',
  '/app/packages/podman-chrome-streaming/node_modules/.bin/funny-server',
  '/app/node_modules/.bin/funny-server',
];

function resolveServerBin(): string {
  if (process.env.FUNNY_SERVER_BIN) {
    return process.env.FUNNY_SERVER_BIN;
  }

  for (const candidate of SERVER_BIN_CANDIDATES) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return SERVER_BIN_CANDIDATES[0];
}

let serverProcess: Subprocess | null = null;

export interface StartFunnyServerOptions {
  workspacePath: string;
  config: RuntimeConfig;
}

export async function startFunnyServer({
  workspacePath,
  config,
}: StartFunnyServerOptions): Promise<void> {
  if (serverProcess) {
    console.log('[funny-server] Server already running, skipping');
    return;
  }

  const serverBin = resolveServerBin();

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    PORT: String(config.funnyPort),
    HOST: '0.0.0.0',
    AUTH_MODE: config.authMode,
    FUNNY_DATA_DIR: config.funnyDataDir,
  };

  if (config.clientOrigin) {
    env.CORS_ORIGIN = config.clientOrigin;
    try {
      env.CLIENT_PORT = String(new URL(config.clientOrigin).port || 80);
    } catch {
      // CORS_ORIGIN is enough for external clients; CLIENT_PORT is only a convenience.
    }
  }

  const credentials = resolveGitCredentials(config);
  if (credentials) {
    env.GH_TOKEN = credentials.token;
  }

  console.log(`[funny-server] Starting @ironmussa/funny-server on port ${config.funnyPort}`);
  console.log(`[funny-server]   bin:   ${serverBin}`);
  console.log(`[funny-server]   cwd:   ${workspacePath}`);
  console.log(`[funny-server]   data:  ${config.funnyDataDir}`);

  serverProcess = Bun.spawn([serverBin], {
    cwd: workspacePath,
    env,
    stdout: 'inherit',
    stderr: 'inherit',
  });

  serverProcess.exited.then((code) => {
    console.log(`[funny-server] Server exited with code ${code}`);
    serverProcess = null;
  });
}

export async function waitForFunnyServerExit(): Promise<number | null> {
  if (!serverProcess) return null;
  return serverProcess.exited;
}

export async function stopFunnyServer(): Promise<void> {
  if (!serverProcess) return;

  console.log('[funny-server] Stopping server...');
  serverProcess.kill('SIGTERM');

  const timeout = setTimeout(() => {
    if (serverProcess) {
      console.log('[funny-server] Force-killing server');
      serverProcess.kill('SIGKILL');
    }
  }, 5000);

  await serverProcess.exited;
  clearTimeout(timeout);
  serverProcess = null;
  console.log('[funny-server] Server stopped');
}
