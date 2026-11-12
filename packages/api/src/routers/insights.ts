/** Analytics and Web Push: per-user reads and the caller's own push subscriptions. */

import { analyticsOverviewQuery, analyticsTimelineQuery } from '@funny/shared/contracts/analytics';
import { pushEndpointBody, pushSubscriptionBody } from '@funny/shared/contracts/push';

import { unwrap } from '../failure.js';
import { protectedProcedure, router } from '../trpc.js';

export const analyticsRouter = router({
  overview: protectedProcedure
    .input(analyticsOverviewQuery.prefault({}))
    .query(async ({ ctx, input }) => unwrap(await ctx.ports.analytics.overview(ctx.userId, input))),
  timeline: protectedProcedure
    .input(analyticsTimelineQuery.prefault({}))
    .query(async ({ ctx, input }) => unwrap(await ctx.ports.analytics.timeline(ctx.userId, input))),
});

export const pushRouter = router({
  config: protectedProcedure.query(async ({ ctx }) => unwrap(await ctx.ports.push.config())),
  subscribe: protectedProcedure
    .input(pushSubscriptionBody)
    .mutation(async ({ ctx, input }) => unwrap(await ctx.ports.push.subscribe(ctx.userId, input))),
  unsubscribe: protectedProcedure
    .input(pushEndpointBody)
    .mutation(async ({ ctx, input }) =>
      unwrap(await ctx.ports.push.unsubscribe(ctx.userId, input.endpoint)),
    ),
  test: protectedProcedure
    .input(pushEndpointBody)
    .mutation(async ({ ctx, input }) =>
      unwrap(await ctx.ports.push.test(ctx.userId, input.endpoint)),
    ),
});
