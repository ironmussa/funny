import {
  createPersonalTokenBody,
  revokePersonalTokenBody,
} from '@funny/shared/contracts/personal-tokens';

import { unwrap } from '../failure.js';
import { protectedProcedure, router } from '../trpc.js';

// The caller's own personal API tokens (public-rest-api-v1).
export const personalTokensRouter = router({
  list: protectedProcedure.query(async ({ ctx }) =>
    unwrap(await ctx.ports.personalTokens.list(ctx.userId)),
  ),
  create: protectedProcedure
    .input(createPersonalTokenBody)
    .mutation(async ({ ctx, input }) =>
      unwrap(await ctx.ports.personalTokens.create(ctx.userId, input)),
    ),
  revoke: protectedProcedure
    .input(revokePersonalTokenBody)
    .mutation(async ({ ctx, input }) =>
      unwrap(await ctx.ports.personalTokens.revoke(ctx.userId, input.id)),
    ),
});
