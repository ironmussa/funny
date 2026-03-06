import { getStatus, resolveLauncherRequest, startContainer, stopContainer } from './podman.ts';
import type { LauncherStartRequest, LauncherStopRequest } from './types.ts';

const LAUNCHER_PORT = parseInt(process.env.LAUNCHER_PORT || '4040', 10);
const LAUNCHER_HOST = process.env.LAUNCHER_HOST || '127.0.0.1';

export function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export async function handleStart(req: Request) {
  const body = (await req.json()) as LauncherStartRequest;
  const config = resolveLauncherRequest(body);
  const status = startContainer(config);
  return json({
    status: 'ready',
    request: redactRequest(body),
    container: status,
  });
}

export async function handleStop(req: Request) {
  const body = req.method === 'POST' ? ((await req.json()) as LauncherStopRequest) : {};
  const status = stopContainer(body);
  return json({
    status: 'stopped',
    container: status,
  });
}

export function handleStatus(req: Request) {
  const url = new URL(req.url);
  const containerName = url.searchParams.get('containerName') || undefined;
  const status = getStatus(containerName);
  return json({
    status: status.running ? 'running' : status.exists ? 'stopped' : 'missing',
    container: status,
  });
}

export function createLauncherFetchHandler() {
  return async function fetch(req: Request) {
    const url = new URL(req.url);

    try {
      if (req.method === 'GET' && url.pathname === '/health') {
        return json({ ok: true, service: 'podman-launcher' });
      }

      if (req.method === 'GET' && url.pathname === '/status') {
        return handleStatus(req);
      }

      if (req.method === 'POST' && url.pathname === '/start') {
        return await handleStart(req);
      }

      if ((req.method === 'POST' || req.method === 'DELETE') && url.pathname === '/stop') {
        return await handleStop(req);
      }

      return json(
        {
          error: 'Not found',
          routes: {
            health: 'GET /health',
            status: 'GET /status?containerName=funny-remote',
            start: 'POST /start',
            stop: 'POST /stop',
          },
        },
        404,
      );
    } catch (error) {
      return json(
        {
          error: error instanceof Error ? error.message : String(error),
        },
        500,
      );
    }
  };
}

export function startLauncherServer() {
  const server = Bun.serve({
    hostname: LAUNCHER_HOST,
    port: LAUNCHER_PORT,
    fetch: createLauncherFetchHandler(),
  });

  console.log(`[launcher] Listening on http://${LAUNCHER_HOST}:${server.port}`);
  console.log('[launcher] Endpoints: GET /health, GET /status, POST /start, POST /stop');
  return server;
}

export function redactRequest(input: LauncherStartRequest): Partial<LauncherStartRequest> {
  return {
    ...input,
    gitToken: input.gitToken ? '***' : undefined,
    gitTokenFilePath: input.gitTokenFilePath ? '***' : undefined,
  };
}

if (import.meta.main) {
  startLauncherServer();
}
