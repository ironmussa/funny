import { threadBodies, threadQueries, threadPatchBody } from '@funny/shared/contracts/threads';
import { z } from 'zod';

import { unwrap } from '../failure.js';
import { protectedProcedure, router, threadProcedure } from '../trpc.js';

const id = z.string().min(1);

/** A list query whose every field is optional: a call without input reads the defaults. */
const listInput = <T extends z.ZodType>(schema: T) => schema.prefault({} as z.input<T>);

export const threadsRouter = router({
  list: protectedProcedure
    .input(listInput(threadQueries.list))
    .query(async ({ ctx, input }) =>
      unwrap(
        await ctx.ports.threads.list(
          { userId: ctx.userId, organizationId: ctx.organizationId },
          input,
        ),
      ),
    ),
  scratch: protectedProcedure
    .input(listInput(threadQueries.scratch))
    .query(async ({ ctx, input }) => unwrap(await ctx.ports.threads.scratch(ctx.userId, input))),
  archived: protectedProcedure
    .input(listInput(threadQueries.archived))
    .query(async ({ ctx, input }) => unwrap(await ctx.ports.threads.archived(ctx.userId, input))),
  searchContent: protectedProcedure
    .input(threadQueries.searchContent)
    .query(async ({ ctx, input }) =>
      unwrap(await ctx.ports.threads.searchContent(ctx.userId, input)),
    ),
  // Authorizes `view` on the row it reads (one query on the hot path), not through
  // threadProcedure.
  get: protectedProcedure
    .input(threadQueries.get.extend({ id }))
    .query(async ({ ctx, input: { id: threadId, ...query } }) =>
      unwrap(await ctx.ports.threads.get(ctx.userId, threadId, query)),
    ),
  messages: threadProcedure('view')
    .input(threadQueries.messages.extend({ id }))
    .query(async ({ ctx, input: { id: threadId, ...query } }) =>
      unwrap(await ctx.ports.threads.messages(threadId, query)),
    ),
  searchMessages: threadProcedure('view')
    .input(threadQueries.searchMessages.extend({ id }))
    .query(async ({ ctx, input: { id: threadId, ...query } }) =>
      unwrap(await ctx.ports.threads.searchMessages(threadId, query)),
    ),
  update: threadProcedure('owner')
    .input(z.object({ id, data: threadPatchBody }))
    .mutation(async ({ ctx, input }) =>
      unwrap(await ctx.ports.threads.update(ctx.userId, ctx.thread, input.data)),
    ),
  setPermissionMode: threadProcedure('owner')
    .input(threadBodies.setPermissionMode.extend({ id }))
    .mutation(async ({ ctx, input }) =>
      unwrap(
        await ctx.ports.threads.setPermissionMode(ctx.userId, ctx.thread.id, input.permissionMode),
      ),
    ),
  setStatus: threadProcedure('owner')
    .input(threadBodies.setStatus.extend({ id }))
    .mutation(async ({ ctx, input }) =>
      unwrap(
        await ctx.ports.threads.setStatus(ctx.userId, ctx.thread.id, input.value, input.reason),
      ),
    ),
  setStage: threadProcedure('owner')
    .input(threadBodies.setStage.extend({ id }))
    .mutation(async ({ ctx, input }) =>
      unwrap(await ctx.ports.threads.setStage(ctx.userId, ctx.thread, input.value, input.reason)),
    ),
});
