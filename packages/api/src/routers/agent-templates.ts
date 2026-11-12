import {
  agentTemplateBody,
  updateAgentTemplateBody,
} from '@funny/shared/contracts/agent-templates';
import { z } from 'zod';

import { unwrap } from '../failure.js';
import { protectedProcedure, resourceProcedure, router } from '../trpc.js';
import { byId, idMutation } from './by-id.js';

/** Only the owner writes a template: 404 / 403 before the body is validated. */
const ownTemplate = resourceProcedure((ports, userId, id) =>
  ports.agentTemplates.authorizeWrite(userId, id),
);

export const agentTemplatesRouter = router({
  list: protectedProcedure.query(async ({ ctx }) =>
    unwrap(await ctx.ports.agentTemplates.list(ctx.userId)),
  ),
  usageStats: protectedProcedure.query(async ({ ctx }) =>
    unwrap(await ctx.ports.agentTemplates.usageStats(ctx.userId)),
  ),
  get: protectedProcedure
    .input(byId)
    .query(async ({ ctx, input }) =>
      unwrap(await ctx.ports.agentTemplates.get(ctx.userId, input.id)),
    ),
  create: protectedProcedure
    .input(agentTemplateBody)
    .mutation(async ({ ctx, input }) =>
      unwrap(await ctx.ports.agentTemplates.create(ctx.userId, input)),
    ),
  update: ownTemplate
    .input(z.object({ id: z.string().min(1), data: updateAgentTemplateBody }))
    .mutation(async ({ ctx, input }) =>
      unwrap(await ctx.ports.agentTemplates.update(ctx.userId, input.id, input.data)),
    ),
  remove: ownTemplate
    .input(byId)
    .mutation(async ({ ctx, input }) =>
      unwrap(await ctx.ports.agentTemplates.remove(ctx.userId, input.id)),
    ),
  duplicate: idMutation((ports, userId, id) => ports.agentTemplates.duplicate(userId, id)),
});
