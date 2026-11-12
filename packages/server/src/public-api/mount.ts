/**
 * Mounts the public REST API v1 at `/api/v1` (openspec public-rest-api-v1),
 * with its OpenAPI document at `GET /api/v1/openapi.json`.
 *
 * It is mounted before the session middleware: `/api/v1` authenticates only
 * with a personal API token (`authenticate`) and never with a session cookie,
 * and every request under it is answered here, never by the runner proxy.
 */

import type { Context, Hono } from 'hono';
import { createOpenApiFetchHandler, generateOpenApiDocument } from 'trpc-to-openapi';

import { log } from '../lib/logger.js';
import type { ServerEnv } from '../lib/types.js';
import { publicV1Router } from './router.js';

const ENDPOINT = '/api/v1';

/** The token's owner, or `null` when the request carries no valid token. */
export type AuthenticateToken = (c: Context<ServerEnv>) => Promise<string | null>;

/** Until personal API tokens exist, nobody is authenticated. */
const noTokens: AuthenticateToken = async () => null;

let document: ReturnType<typeof generateOpenApiDocument> | null = null;

function openApiDocument() {
  document ??= generateOpenApiDocument(publicV1Router, {
    title: 'funny public API',
    description:
      'Create threads and read your projects from outside the web app. Authenticate with a personal API token (Settings) as `Authorization: Bearer <token>`.',
    version: '1.0.0',
    baseUrl: ENDPOINT,
    securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } },
  });
  return document;
}

export function mountPublicApi(app: Hono<ServerEnv>, authenticate: AuthenticateToken = noTokens) {
  app.get(`${ENDPOINT}/openapi.json`, (c) => c.json(openApiDocument()));
  app.all(`${ENDPOINT}/*`, (c) =>
    createOpenApiFetchHandler({
      endpoint: ENDPOINT,
      router: publicV1Router,
      req: c.req.raw,
      createContext: async () => ({ userId: await authenticate(c) }),
      onError: ({ error, path }) => {
        if (error.code !== 'INTERNAL_SERVER_ERROR') return;
        log.error('Public API request failed', { namespace: 'public-api', path });
      },
    }),
  );
}
