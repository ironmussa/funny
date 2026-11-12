import { createPipelineBody, updatePipelineBody } from '@funny/shared/contracts/pipelines';
import { z } from 'zod';

import { unwrap } from '../failure.js';
import { protectedProcedure, router } from '../trpc.js';
import { byId, idMutation } from './by-id.js';

export const pipelinesRouter = router({
  list: protectedProcedure
    .input(z.object({ projectId: z.string().min(1) }))
    .query(async ({ ctx, input }) =>
      unwrap(await ctx.ports.pipelines.list(ctx.userId, input.projectId)),
    ),
  get: protectedProcedure
    .input(byId)
    .query(async ({ ctx, input }) => unwrap(await ctx.ports.pipelines.get(ctx.userId, input.id))),
  create: protectedProcedure
    .input(createPipelineBody)
    .mutation(async ({ ctx, input }) =>
      unwrap(await ctx.ports.pipelines.create(ctx.userId, input)),
    ),
  update: protectedProcedure
    .input(z.object({ id: z.string().min(1), data: updatePipelineBody }))
    .mutation(async ({ ctx, input }) =>
      unwrap(await ctx.ports.pipelines.update(ctx.userId, input.id, input.data)),
    ),
  remove: idMutation((ports, userId, id) => ports.pipelines.remove(userId, id)),
  runsForThread: protectedProcedure
    .input(z.object({ threadId: z.string().min(1) }))
    .query(async ({ ctx, input }) =>
      unwrap(await ctx.ports.pipelines.runsForThread(ctx.userId, input.threadId)),
    ),
});
