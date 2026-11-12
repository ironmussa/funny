/**
 * The tRPC instance of the public REST API v1 (openspec public-rest-api-v1).
 * Separate from the web client's `@funny/api` router: its procedures carry
 * `meta.openapi` and output schemas, are served only under `/api/v1` by
 * `trpc-to-openapi`, and authenticate only with a personal API token.
 */

import { ApiFailureCause } from '@funny/api';
import { initTRPC, TRPCError } from '@trpc/server';
import type { OpenApiMeta } from 'trpc-to-openapi';

import { log } from '../lib/logger.js';

/** Who is calling: set from a valid personal API token, `null` without one. */
export interface PublicApiContext {
  userId: string | null;
}

const t = initTRPC.meta<OpenApiMeta>().context<PublicApiContext>().create({ isDev: false });

export const router = t.router;

/**
 * An unexpected error answers `Internal server error`; only failures a port
 * reports on purpose (`ApiFailure`) and tRPC's own errors keep their message.
 */
const hideInternalErrors = t.middleware(async ({ next, path }) => {
  const result = await next();
  if (
    !result.ok &&
    result.error.code === 'INTERNAL_SERVER_ERROR' &&
    !(result.error.cause instanceof ApiFailureCause)
  ) {
    log.error('Public API procedure failed', {
      namespace: 'public-api',
      path,
      error: result.error.cause?.message ?? result.error.message,
    });
    result.error.message = 'Internal server error';
  }
  return result;
});

/** A procedure for the holder of a personal API token (401 otherwise). */
export const tokenProcedure = t.procedure.use(hideInternalErrors).use(({ ctx, next }) => {
  if (!ctx.userId) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'A personal API token is required' });
  }
  return next({ ctx: { ...ctx, userId: ctx.userId } });
});
