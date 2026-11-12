/**
 * The tRPC instance every router builds on: the request context, the error
 * formatter, and the public / protected procedure builders.
 */

import { initTRPC, TRPCError } from '@trpc/server';

import { ApiFailureCause } from './failure.js';
import type { ApiPorts } from './ports.js';

export interface ApiContext {
  /** The session's user; `null` when the request has none. */
  userId: string | null;
  organizationId: string | null;
  ports: ApiPorts;
}

/** Validation causes (zod, Standard Schema) expose their issues. */
function firstIssueMessage(cause: unknown): string | undefined {
  const issues = (cause as { issues?: { message?: unknown }[] } | undefined)?.issues;
  const message = Array.isArray(issues) ? issues[0]?.message : undefined;
  return typeof message === 'string' ? message : undefined;
}

const t = initTRPC.context<ApiContext>().create({
  // Never put stack traces in responses, whatever NODE_ENV says.
  isDev: false,
  errorFormatter({ shape, error }) {
    const cause = error.cause;
    if (cause instanceof ApiFailureCause) {
      return cause.failure.friendlyMessage === undefined
        ? shape
        : { ...shape, friendlyMessage: cause.failure.friendlyMessage };
    }
    if (error.code === 'BAD_REQUEST') {
      // Same text the REST routes answer: the first validation issue.
      const message = firstIssueMessage(cause);
      return message === undefined ? shape : { ...shape, message };
    }
    if (error.code === 'INTERNAL_SERVER_ERROR') {
      // An unexpected throw: the server logs it (`onError`), the client gets no details.
      return { ...shape, message: 'Internal server error' };
    }
    return shape;
  },
});

export const router = t.router;

/** Refuses a request without a user (401) before input is validated or the handler runs. */
export const protectedProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.userId) throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Unauthorized' });
  return next({ ctx: { ...ctx, userId: ctx.userId } });
});
