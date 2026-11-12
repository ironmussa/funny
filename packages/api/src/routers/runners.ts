import {
  approveEnrollmentBody,
  assignRunnerProjectBody,
  setGeneralRunnerBody,
  updateProjectRunnerSettingsBody,
} from '@funny/shared/contracts/runners';
import { z } from 'zod';

import { unwrap } from '../failure.js';
import { protectedProcedure, router } from '../trpc.js';

const runnerId = z.string().min(1);
const projectId = z.string().min(1);

// Ownership is checked by the ports, which answer 404 for someone else's runner
// or project. What a runner calls with its own credential stays REST.
export const runnersRouter = router({
  list: protectedProcedure.query(async ({ ctx }) =>
    unwrap(await ctx.ports.runners.list({ userId: ctx.userId, role: ctx.userRole })),
  ),
  remove: protectedProcedure
    .input(z.object({ runnerId }))
    .mutation(async ({ ctx, input }) =>
      unwrap(
        await ctx.ports.runners.remove({ userId: ctx.userId, role: ctx.userRole }, input.runnerId),
      ),
    ),
  assignProject: protectedProcedure
    .input(assignRunnerProjectBody.extend({ runnerId }))
    .mutation(async ({ ctx, input: { runnerId: id, ...data } }) =>
      unwrap(
        await ctx.ports.runners.assignProject({ userId: ctx.userId, role: ctx.userRole }, id, data),
      ),
    ),
  unassignProject: protectedProcedure
    .input(z.object({ runnerId, projectId }))
    .mutation(async ({ ctx, input }) =>
      unwrap(
        await ctx.ports.runners.unassignProject(
          { userId: ctx.userId, role: ctx.userRole },
          input.runnerId,
          input.projectId,
        ),
      ),
    ),
  enrollment: protectedProcedure
    .input(z.object({ userCode: z.string().min(1) }))
    .query(async ({ ctx, input }) => unwrap(await ctx.ports.runners.enrollment(input.userCode))),
  approveEnrollment: protectedProcedure
    .input(approveEnrollmentBody)
    .mutation(async ({ ctx, input }) =>
      unwrap(await ctx.ports.runners.approveEnrollment(ctx.userId, input.userCode)),
    ),
});

/** The project's runner binding; owner-only (the port answers 404 for anyone else). */
export const projectRunnersRouter = router({
  settings: protectedProcedure
    .input(z.object({ projectId }))
    .query(async ({ ctx, input }) =>
      unwrap(await ctx.ports.projectRunners.settings(ctx.userId, input.projectId)),
    ),
  update: protectedProcedure
    .input(z.object({ projectId, data: updateProjectRunnerSettingsBody }))
    .mutation(async ({ ctx, input }) =>
      unwrap(await ctx.ports.projectRunners.update(ctx.userId, input.projectId, input.data)),
    ),
  grant: protectedProcedure
    .input(z.object({ projectId, runnerId }))
    .mutation(async ({ ctx, input }) =>
      unwrap(await ctx.ports.projectRunners.grant(ctx.userId, input.projectId, input.runnerId)),
    ),
  revoke: protectedProcedure
    .input(z.object({ projectId, runnerId }))
    .mutation(async ({ ctx, input }) =>
      unwrap(await ctx.ports.projectRunners.revoke(ctx.userId, input.projectId, input.runnerId)),
    ),
  setGeneralRunner: protectedProcedure
    .input(setGeneralRunnerBody)
    .mutation(async ({ ctx, input }) =>
      unwrap(await ctx.ports.projectRunners.setGeneralRunner(ctx.userId, input.runnerId)),
    ),
});
