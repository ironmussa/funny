import {
  automationInboxQuery,
  createAutomationBody,
  listAutomationsQuery,
  runTriageStatus,
  updateAutomationBody,
} from '@funny/shared/contracts/automations';
import { z } from 'zod';

import { unwrap } from '../failure.js';
import { protectedProcedure, router } from '../trpc.js';
import { byId, idMutation } from './by-id.js';

export const automationsRouter = router({
  inbox: protectedProcedure
    .input(automationInboxQuery.optional())
    .query(async ({ ctx, input }) =>
      unwrap(await ctx.ports.automations.inbox(ctx.userId, input ?? {})),
    ),
  list: protectedProcedure
    .input(listAutomationsQuery.optional())
    .query(async ({ ctx, input }) =>
      unwrap(await ctx.ports.automations.list(ctx.userId, input ?? {})),
    ),
  get: protectedProcedure
    .input(byId)
    .query(async ({ ctx, input }) => unwrap(await ctx.ports.automations.get(ctx.userId, input.id))),
  create: protectedProcedure
    .input(createAutomationBody)
    .mutation(async ({ ctx, input }) =>
      unwrap(await ctx.ports.automations.create(ctx.userId, input)),
    ),
  update: protectedProcedure
    .input(z.object({ id: z.string().min(1), data: updateAutomationBody }))
    .mutation(async ({ ctx, input }) =>
      unwrap(await ctx.ports.automations.update(ctx.userId, input.id, input.data)),
    ),
  remove: idMutation((ports, userId, id) => ports.automations.remove(userId, id)),
  trigger: idMutation((ports, userId, id) => ports.automations.trigger(userId, id)),
  runs: protectedProcedure
    .input(byId)
    .query(async ({ ctx, input }) =>
      unwrap(await ctx.ports.automations.runs(ctx.userId, input.id)),
    ),
  triageRun: protectedProcedure
    .input(z.object({ runId: z.string().min(1), triageStatus: runTriageStatus }))
    .mutation(async ({ ctx, input }) =>
      unwrap(await ctx.ports.automations.triageRun(ctx.userId, input.runId, input.triageStatus)),
    ),
});
