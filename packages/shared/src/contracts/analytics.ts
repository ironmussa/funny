/**
 * `/api/analytics` queries and responses (served over tRPC, `@funny/api`
 * `analytics` router, and by the REST routes).
 */

import { z } from 'zod';

export const analyticsOverviewQuery = z.object({
  projectId: z.string().optional(),
  timeRange: z.string().optional(),
  /** The browser's `getTimezoneOffset()`, in minutes. */
  tz: z.coerce.number().default(0),
});

export const analyticsTimelineQuery = analyticsOverviewQuery.extend({
  groupBy: z.string().default('day'),
});

export type AnalyticsOverviewQuery = z.output<typeof analyticsOverviewQuery>;
export type AnalyticsTimelineQuery = z.output<typeof analyticsTimelineQuery>;

interface TimeRange {
  start: string;
  end: string;
}

export interface AnalyticsOverview {
  currentStageDistribution: Record<string, number>;
  createdCount: number;
  completedCount: number;
  movedToPlanningCount: number;
  movedToReviewCount: number;
  movedToDoneCount: number;
  movedToArchivedCount: number;
  totalCost: number;
  timeRange: TimeRange;
}

type DateCounts = Array<{ date: string; count: number }>;

export interface AnalyticsTimeline {
  createdByDate: DateCounts;
  completedByDate: DateCounts;
  movedToPlanningByDate: DateCounts;
  movedToReviewByDate: DateCounts;
  movedToDoneByDate: DateCounts;
  movedToArchivedByDate: DateCounts;
  timeRange: TimeRange;
  groupBy: string;
}
