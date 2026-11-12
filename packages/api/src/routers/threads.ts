import { threadsContract as contract, threadPatchBody } from '@funny/shared/contracts/threads';
import { z } from 'zod';

import { unwrap } from '../failure.js';
import { protectedProcedure, router, threadProcedure } from '../trpc.js';

const id = z.string().min(1);

/** A list query whose every field is optional: a call without input reads the defaults. */
const listInput = <T extends z.ZodType>(schema: T) => schema.prefault({} as z.input<T>);

export const threadsRouter = router({
  list: protectedProcedure
    .input(listInput(contract.list.query))
    .query(async ({ ctx, input }) =>
      unwrap(
        await ctx.ports.threads.list(
          { userId: ctx.userId, organizationId: ctx.organizationId },
          input,
        ),
      ),
    ),
  scratch: protectedProcedure
    .input(listInput(contract.scratch.query))
    .query(async ({ ctx, input }) => unwrap(await ctx.ports.threads.scratch(ctx.userId, input))),
  archived: protectedProcedure
    .input(listInput(contract.archived.query))
    .query(async ({ ctx, input }) => unwrap(await ctx.ports.threads.archived(ctx.userId, input))),
  searchContent: protectedProcedure
    .input(contract.searchContent.query)
    .query(async ({ ctx, input }) =>
      unwrap(await ctx.ports.threads.searchContent(ctx.userId, input)),
    ),
  // Authorizes `view` on the row it reads (one query on the hot path), not through
  // threadProcedure.
  get: protectedProcedure
    .input(contract.get.query.extend({ id }))
    .query(async ({ ctx, input: { id: threadId, ...query } }) =>
      unwrap(await ctx.ports.threads.get(ctx.userId, threadId, query)),
    ),
  messages: threadProcedure('view')
    .input(contract.messages.query.extend({ id }))
    .query(async ({ ctx, input: { id: threadId, ...query } }) =>
      unwrap(await ctx.ports.threads.messages(threadId, query)),
    ),
  searchMessages: threadProcedure('view')
    .input(contract.searchMessages.query.extend({ id }))
    .query(async ({ ctx, input: { id: threadId, ...query } }) =>
      unwrap(await ctx.ports.threads.searchMessages(threadId, query)),
    ),
  update: threadProcedure('owner')
    .input(z.object({ id, data: threadPatchBody }))
    .mutation(async ({ ctx, input }) =>
      unwrap(await ctx.ports.threads.update(ctx.userId, ctx.thread, input.data)),
    ),
  setPermissionMode: threadProcedure('owner')
    .input(contract.setPermissionMode.body.extend({ id }))
    .mutation(async ({ ctx, input }) =>
      unwrap(
        await ctx.ports.threads.setPermissionMode(ctx.userId, ctx.thread.id, input.permissionMode),
      ),
    ),
  setStatus: threadProcedure('owner')
    .input(contract.setStatus.body.extend({ id }))
    .mutation(async ({ ctx, input }) =>
      unwrap(
        await ctx.ports.threads.setStatus(ctx.userId, ctx.thread.id, input.value, input.reason),
      ),
    ),
  setStage: threadProcedure('owner')
    .input(contract.setStage.body.extend({ id }))
    .mutation(async ({ ctx, input }) =>
      unwrap(await ctx.ports.threads.setStage(ctx.userId, ctx.thread, input.value, input.reason)),
    ),
});
