import { updateProfileBody } from '@funny/shared/contracts/profile';

import { unwrap } from '../failure.js';
import { protectedProcedure, router } from '../trpc.js';

export const profileRouter = router({
  get: protectedProcedure.query(async ({ ctx }) => unwrap(await ctx.ports.profile.get(ctx.userId))),
  update: protectedProcedure
    .input(updateProfileBody)
    .mutation(async ({ ctx, input }) => unwrap(await ctx.ports.profile.update(ctx.userId, input))),
  transcribeToken: protectedProcedure.query(async ({ ctx }) =>
    unwrap(await ctx.ports.profile.transcribeToken(ctx.userId)),
  ),
  setupCompleted: protectedProcedure.query(async ({ ctx }) =>
    unwrap(await ctx.ports.profile.setupCompleted(ctx.userId)),
  ),
  runnerInviteToken: protectedProcedure.query(async ({ ctx }) =>
    unwrap(await ctx.ports.profile.runnerInviteToken(ctx.userId)),
  ),
  rotateRunnerInviteToken: protectedProcedure.mutation(async ({ ctx }) =>
    unwrap(await ctx.ports.profile.rotateRunnerInviteToken(ctx.userId)),
  ),
});
