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
import { createSlidingWindowLimiter } from '../middleware/rate-limit.js';
import { verifyPersonalAccessToken } from '../services/personal-access-tokens.js';
import { publicV1Router } from './router.js';
import type { PublicApiContext } from './trpc.js';

const ENDPOINT = '/api/v1';

/** The token's owner, or `null` when the request carries no valid token. */
export type AuthenticateToken = (c: Context<ServerEnv>) => Promise<string | null>;

/** The owner of the request's personal API token (`Authorization: Bearer funny_pat_…`). */
const personalAccessToken: AuthenticateToken = (c) =>
  verifyPersonalAccessToken(c.req.header('authorization'));

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

/** Requests one token owner may make per minute (on top of the per-IP limit in app.ts). */
const PER_TOKEN_PER_MINUTE = 120;

export function mountPublicApi(
  app: Hono<ServerEnv>,
  authenticate: AuthenticateToken = personalAccessToken,
  { perTokenPerMinute = PER_TOKEN_PER_MINUTE }: { perTokenPerMinute?: number } = {},
) {
  const perToken = createSlidingWindowLimiter({ windowMs: 60_000, max: perTokenPerMinute });
  app.get(`${ENDPOINT}/openapi.json`, (c) => c.json(openApiDocument()));
  app.all(`${ENDPOINT}/*`, async (c) => {
    const userId = await authenticate(c);
    if (userId && perToken.hit(`pat:${userId}`)) {
      c.header('Retry-After', '60');
      return c.json({ message: 'Too many requests', code: 'TOO_MANY_REQUESTS' }, 429);
    }
    return createOpenApiFetchHandler({
      endpoint: ENDPOINT,
      router: publicV1Router,
      req: c.req.raw,
      createContext: async (): Promise<PublicApiContext> => ({ userId }),
      onError: ({ error, path }) => {
        if (error.code !== 'INTERNAL_SERVER_ERROR') return;
        log.error('Public API request failed', { namespace: 'public-api', path });
      },
    });
  });
}
