import {
  createAgentExecutionProfileSchema,
  updateAgentExecutionProfileSchema,
  updateProjectAgentProfileBindingSchema,
} from '@funny/shared';
import { smtpSettingsBody } from '@funny/shared/contracts/settings';
import { z } from 'zod';

import { unwrap } from '../failure.js';
import { adminProcedure, projectProcedure, protectedProcedure, router } from '../trpc.js';

const id = z.string().min(1);
const projectId = z.string().min(1);

export const settingsRouter = router({
  // ── Agent execution profiles (per user) ──
  listAgentProfiles: protectedProcedure.query(async ({ ctx }) =>
    unwrap(await ctx.ports.settings.listAgentProfiles(ctx.userId)),
  ),
  createAgentProfile: protectedProcedure
    .input(createAgentExecutionProfileSchema)
    .mutation(async ({ ctx, input }) =>
      unwrap(await ctx.ports.settings.createAgentProfile(ctx.userId, input)),
    ),
  updateAgentProfile: protectedProcedure
    .input(z.object({ id, data: updateAgentExecutionProfileSchema }))
    .mutation(async ({ ctx, input }) =>
      unwrap(await ctx.ports.settings.updateAgentProfile(ctx.userId, input.id, input.data)),
    ),
  deleteAgentProfile: protectedProcedure
    .input(z.object({ id }))
    .mutation(async ({ ctx, input }) =>
      unwrap(await ctx.ports.settings.deleteAgentProfile(ctx.userId, input.id)),
    ),
  getProjectBinding: projectProcedure('view')
    .input(z.object({ projectId }))
    .query(async ({ ctx, input }) =>
      unwrap(await ctx.ports.settings.getProjectBinding(ctx.userId, input.projectId)),
    ),
  setProjectBinding: projectProcedure('view')
    .input(updateProjectAgentProfileBindingSchema.extend({ projectId }))
    .mutation(async ({ ctx, input }) =>
      unwrap(
        await ctx.ports.settings.setProjectBinding(ctx.userId, input.projectId, input.profileId),
      ),
    ),

  // ── SMTP (instance-level, admin only) ──
  getSmtp: adminProcedure.query(async ({ ctx }) => unwrap(await ctx.ports.settings.getSmtp())),
  saveSmtp: adminProcedure
    .input(smtpSettingsBody)
    .mutation(async ({ ctx, input }) => unwrap(await ctx.ports.settings.saveSmtp(input))),
  testSmtp: adminProcedure.mutation(async ({ ctx }) => unwrap(await ctx.ports.settings.testSmtp())),
});
