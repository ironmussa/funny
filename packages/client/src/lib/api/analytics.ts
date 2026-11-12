import { request } from './_core';
import { trpc, trpcCall } from './_trpc';

/** Minutes behind UTC, as the server buckets dates in the browser's time zone. */
const tz = () => new Date().getTimezoneOffset();

export const analyticsApi = {
  // Analytics
  analyticsOverview: (projectId?: string, timeRange?: string) =>
    trpcCall(() =>
      trpc.analytics.overview.query({ projectId: projectId || undefined, timeRange, tz: tz() }),
    ),
  analyticsTimeline: (projectId?: string, timeRange?: string, groupBy?: string) =>
    trpcCall(() =>
      trpc.analytics.timeline.query({
        projectId: projectId || undefined,
        timeRange,
        groupBy,
        tz: tz(),
      }),
    ),

  // Logs (observability)
  sendLogs: (
    logs: Array<{ level: string; message: string; attributes?: Record<string, string> }>,
  ) => request<{ ok: boolean }>('/logs', { method: 'POST', body: JSON.stringify({ logs }) }),
};
