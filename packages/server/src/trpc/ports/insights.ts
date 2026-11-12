/**
 * Analytics and Web Push, for both their REST routes and the `analytics` /
 * `push` tRPC routers.
 */

import { failure, type AnalyticsPort, type PushPort } from '@funny/api';
import { err, ok } from 'neverthrow';

import { getOverview, getTimeline } from '../../services/analytics-service.js';
import {
  pushConfig,
  removeSubscription,
  saveSubscription,
  sendPush,
} from '../../services/web-push.js';

export const analyticsPort: AnalyticsPort = {
  async overview(userId, query) {
    return ok(
      await getOverview({
        userId,
        projectId: query.projectId,
        timeRange: query.timeRange,
        offsetMinutes: query.tz || 0,
      }),
    );
  },

  async timeline(userId, query) {
    return ok(
      await getTimeline({
        userId,
        projectId: query.projectId,
        timeRange: query.timeRange,
        groupBy: query.groupBy,
        offsetMinutes: query.tz || 0,
      }),
    );
  },
};

export const pushPort: PushPort = {
  async config() {
    return ok({ publicKey: pushConfig()?.publicKey ?? null });
  },

  async subscribe(userId, subscription) {
    if (!pushConfig()) return err(failure(503, 'Web Push is not configured on the server'));
    await saveSubscription(userId, subscription);
    return ok({ ok: true as const });
  },

  async unsubscribe(userId, endpoint) {
    await removeSubscription(userId, endpoint);
    return ok({ ok: true as const });
  },

  async test(userId, endpoint) {
    const sent = await sendPush(
      userId,
      { title: 'funny', body: 'Web Push is working', url: '/', tag: 'push-test' },
      endpoint,
    );
    return sent
      ? ok({ ok: true as const })
      : err(failure(503, 'Push delivery failed or subscription unavailable'));
  },
};
