/**
 * Mounts the `@funny/api` tRPC router at `/api/trpc/*` (openspec change
 * adopt-trpc-browser-api). Register it after the session middleware and before
 * the runner proxy catch-all, so procedure calls get the same CORS, CSRF,
 * rate-limit and auth handling as REST and never reach a runner.
 */

import { appRouter, TRPC_PATH, type ApiPorts } from '@funny/api';
import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import type { Context, Hono } from 'hono';

import { log } from '../lib/logger.js';
import type { ServerEnv } from '../lib/types.js';
import { authzPort } from './ports/authz.js';
import { automationsPort } from './ports/automations.js';
import { pipelinesPort } from './ports/pipelines.js';
import { profilePort } from './ports/profile.js';
import { settingsPort } from './ports/settings.js';
import { threadAccessPort } from './ports/thread-access.js';
import { createThreadsPort } from './ports/threads.js';

/** The server's ports for one request: writes broadcast through the request's event sink. */
function serverPorts(c: Context<ServerEnv>): ApiPorts {
  return {
    automations: automationsPort,
    pipelines: pipelinesPort,
    threads: createThreadsPort(c.env?.browserEvents),
    profile: profilePort,
    settings: settingsPort,
    threadAccess: threadAccessPort,
    authz: authzPort,
  };
}

const ENDPOINT = `/api${TRPC_PATH}`;

export function mountTrpc(
  app: Hono<ServerEnv>,
  portsFor: (c: Context<ServerEnv>) => ApiPorts = serverPorts,
): void {
  app.all(`${ENDPOINT}/*`, (c) =>
    fetchRequestHandler({
      endpoint: ENDPOINT,
      req: c.req.raw,
      router: appRouter,
      createContext: () => ({
        userId: c.get('userId') || null,
        userRole: c.get('userId') ? (c.get('userRole') ?? null) : null,
        organizationId: c.get('organizationId') ?? null,
        ports: portsFor(c),
      }),
      onError: ({ error, path }) => {
        if (error.code !== 'INTERNAL_SERVER_ERROR') return;
        log.error('tRPC procedure failed', {
          namespace: 'trpc',
          path,
          error: error.cause?.message ?? error.message,
          stack: error.cause?.stack,
        });
      },
    }),
  );
}
