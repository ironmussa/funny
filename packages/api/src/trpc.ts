/**
 * The tRPC instance every router builds on: the request context, the error
 * formatter, and the public / protected procedure builders.
 */

import { initTRPC, TRPCError } from '@trpc/server';
import { z } from 'zod';

import { ApiFailureCause } from './failure.js';
import type { ApiPorts, ThreadAccessLevel } from './ports.js';

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

const threadIdInput = z.object({ id: z.string().min(1) });

/**
 * A procedure on one thread, whose input carries the thread `id`. Resolves and
 * authorizes the thread at `level` BEFORE the input is validated, so an
 * inaccessible or missing thread answers 404 before a bad payload answers 400
 * (the REST `requireThread*` middlewares' order). The handler reads `ctx.thread`.
 */
export function threadProcedure(level: ThreadAccessLevel) {
  return protectedProcedure.use(async ({ ctx, getRawInput, next }) => {
    const parsed = threadIdInput.safeParse(await getRawInput());
    const thread = parsed.success
      ? await ctx.ports.threadAccess.authorize(level, parsed.data.id, ctx.userId)
      : null;
    if (!thread) throw new TRPCError({ code: 'NOT_FOUND', message: 'Thread not found' });
    return next({ ctx: { ...ctx, thread } });
  });
}
