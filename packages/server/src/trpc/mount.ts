/**
 * Mounts the `@funny/api` tRPC router at `/api/trpc/*` (openspec change
 * adopt-trpc-browser-api). Register it after the session middleware and before
 * the runner proxy catch-all, so procedure calls get the same CORS, CSRF,
 * rate-limit and auth handling as REST and never reach a runner.
 */

import { appRouter, TRPC_PATH, type ApiPorts } from '@funny/api';
import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import type { Hono } from 'hono';

import { log } from '../lib/logger.js';
import type { ServerEnv } from '../lib/types.js';
import { automationsPort } from './ports/automations.js';

const serverPorts: ApiPorts = {
  automations: automationsPort,
};

const ENDPOINT = `/api${TRPC_PATH}`;

export function mountTrpc(app: Hono<ServerEnv>, ports: ApiPorts = serverPorts): void {
  app.all(`${ENDPOINT}/*`, (c) =>
    fetchRequestHandler({
      endpoint: ENDPOINT,
      req: c.req.raw,
      router: appRouter,
      createContext: () => ({
        userId: c.get('userId') || null,
        organizationId: c.get('organizationId') ?? null,
        ports,
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
