/**
 * Analytics service — query logic for overview and timeline analytics.
 * Extracted from the analytics route to maintain proper layering (routes → services → db).
 */

import { eq, and, gte, lt, sql } from 'drizzle-orm';
import { db, schema } from '../db/index.js';

type TimeRange = 'day' | 'week' | 'month' | 'all';
type GroupBy = 'day' | 'week' | 'month' | 'year';

/**
 * Converts a browser getTimezoneOffset() value (minutes) to an SQLite modifier
 * string. getTimezoneOffset() returns positive values for west of UTC (e.g. 300
 * for UTC-5) so we negate it before formatting.
 */
function tzOffsetToModifier(offsetMinutes: number): string {
  const total = -offsetMinutes;
  const sign = total >= 0 ? '+' : '-';
  const abs = Math.abs(total);
  const h = String(Math.floor(abs / 60)).padStart(2, '0');
  const m = String(abs % 60).padStart(2, '0');
  return `${sign}${h}:${m}`;
}

/** Returns a SQL expression that buckets a date column by the requested granularity. */
function dateBucket(column: any, groupBy: GroupBy, tzMod: string) {
  switch (groupBy) {
    case 'week':
      return sql`strftime('%Y-W%W', datetime(${column}, ${tzMod}))`;
    case 'month':
      return sql`strftime('%Y-%m', datetime(${column}, ${tzMod}))`;
    case 'year':
      return sql`strftime('%Y', datetime(${column}, ${tzMod}))`;
    case 'day':
    default:
      return sql`DATE(${column}, ${tzMod})`;
  }
}

function getDateRange(timeRange?: string, _offsetMinutes = 0, startDate?: string, endDate?: string) {
  const now = new Date();
  const end = endDate ? new Date(endDate) : now;

  let start: Date;
  switch (timeRange as TimeRange) {
    case 'day':
      start = new Date(now);
      start.setDate(start.getDate() - 1);
      break;
    case 'week':
      start = new Date(now);
      start.setDate(start.getDate() - 7);
      break;
    case 'all':
      start = new Date(0);
      break;
    case 'month':
    default:
      start = startDate ? new Date(startDate) : new Date(now);
      if (!startDate) start.setMonth(start.getMonth() - 1);
      break;
  }

  return { start: start.toISOString(), end: end.toISOString() };
}

/** Build base Drizzle filters for analytics queries. */
function baseFiltersFor(opts: { projectId?: string; userId: string }) {
  const filters: ReturnType<typeof eq>[] = [];
  if (opts.projectId) {
    filters.push(eq(schema.threads.projectId, opts.projectId));
  }
  if (opts.userId !== '__local__') {
    filters.push(eq(schema.threads.userId, opts.userId));
  }
  return filters;
}

/** Count stage transitions to a given stage within a date range. */
function countTransitionsTo(stage: string, baseFilters: ReturnType<typeof eq>[], range: { start: string; end: string }) {
  const result = db
    .select({ count: sql<number>`COUNT(DISTINCT ${schema.stageHistory.threadId})` })
    .from(schema.stageHistory)
    .innerJoin(schema.threads, eq(schema.stageHistory.threadId, schema.threads.id))
    .where(and(
      ...baseFilters,
      eq(schema.stageHistory.toStage, stage),
      gte(schema.stageHistory.changedAt, range.start),
      lt(schema.stageHistory.changedAt, range.end),
    ))
    .get();
  return result?.count ?? 0;
}

// ── Public API ──────────────────────────────────────────────────

export interface OverviewParams {
  userId: string;
  projectId?: string;
  timeRange?: string;
  offsetMinutes?: number;
}

export function getOverview(params: OverviewParams) {
  const { userId, projectId, timeRange, offsetMinutes = 0 } = params;
  const range = getDateRange(timeRange, offsetMinutes);
  const filters = baseFiltersFor({ projectId, userId });

  // Current stage distribution (non-archived threads by stage)
  const stageRows = db
    .select({
      stage: schema.threads.stage,
      count: sql<number>`COUNT(*)`,
    })
    .from(schema.threads)
    .where(and(...filters, eq(schema.threads.archived, 0)))
    .groupBy(schema.threads.stage)
    .all();

  const archivedResult = db
    .select({ count: sql<number>`COUNT(*)` })
    .from(schema.threads)
    .where(and(...filters, eq(schema.threads.archived, 1)))
    .get();

  const distribution: Record<string, number> = {
    backlog: 0,
    planning: 0,
    in_progress: 0,
    review: 0,
    done: 0,
    archived: archivedResult?.count ?? 0,
  };
  for (const row of stageRows) {
    distribution[row.stage] = row.count;
  }

  // Threads created in time range
  const createdResult = db
    .select({ count: sql<number>`COUNT(*)` })
    .from(schema.threads)
    .where(and(...filters, gte(schema.threads.createdAt, range.start), lt(schema.threads.createdAt, range.end)))
    .get();

  // Threads completed in time range
  const completedResult = db
    .select({ count: sql<number>`COUNT(*)` })
    .from(schema.threads)
    .where(and(
      ...filters,
      sql`${schema.threads.completedAt} IS NOT NULL`,
      gte(schema.threads.completedAt, range.start),
      lt(schema.threads.completedAt, range.end),
    ))
    .get();

  const totalCostResult = db
    .select({ total: sql<number>`COALESCE(SUM(${schema.threads.cost}), 0)` })
    .from(schema.threads)
    .where(and(...filters, gte(schema.threads.createdAt, range.start), lt(schema.threads.createdAt, range.end)))
    .get();

  return {
    currentStageDistribution: distribution,
    createdCount: createdResult?.count ?? 0,
    completedCount: completedResult?.count ?? 0,
    movedToPlanningCount: countTransitionsTo('planning', filters, range),
    movedToReviewCount: countTransitionsTo('review', filters, range),
    movedToDoneCount: countTransitionsTo('done', filters, range),
    movedToArchivedCount: countTransitionsTo('archived', filters, range),
    totalCost: totalCostResult?.total ?? 0,
    timeRange: range,
  };
}

export interface TimelineParams {
  userId: string;
  projectId?: string;
  timeRange?: string;
  groupBy?: string;
  offsetMinutes?: number;
}

/** Get timeline by-date bucket for a specific stage transition. */
function stageTransitionsByDate(stage: string, baseFilters: ReturnType<typeof eq>[], range: { start: string; end: string }, groupBy: GroupBy, tzMod: string) {
  const bucket = dateBucket(schema.stageHistory.changedAt, groupBy, tzMod);
  return db
    .select({
      date: bucket.as('date'),
      count: sql<number>`COUNT(DISTINCT ${schema.stageHistory.threadId})`,
    })
    .from(schema.stageHistory)
    .innerJoin(schema.threads, eq(schema.stageHistory.threadId, schema.threads.id))
    .where(and(
      ...baseFilters,
      eq(schema.stageHistory.toStage, stage),
      gte(schema.stageHistory.changedAt, range.start),
      lt(schema.stageHistory.changedAt, range.end),
    ))
    .groupBy(bucket)
    .orderBy(bucket)
    .all();
}

export function getTimeline(params: TimelineParams) {
  const { userId, projectId, timeRange, groupBy: gb = 'day', offsetMinutes = 0 } = params;
  const groupBy = gb as GroupBy;
  const tzMod = tzOffsetToModifier(offsetMinutes);
  const range = getDateRange(timeRange, offsetMinutes);
  const filters = baseFiltersFor({ projectId, userId });

  // Tasks created by date
  const createdBucket = dateBucket(schema.threads.createdAt, groupBy, tzMod);
  const createdByDate = db
    .select({ date: createdBucket.as('date'), count: sql<number>`COUNT(*)` })
    .from(schema.threads)
    .where(and(...filters, gte(schema.threads.createdAt, range.start), lt(schema.threads.createdAt, range.end)))
    .groupBy(createdBucket)
    .orderBy(createdBucket)
    .all();

  // Tasks completed by date
  const completedBucket = dateBucket(schema.threads.completedAt, groupBy, tzMod);
  const completedByDate = db
    .select({ date: completedBucket.as('date'), count: sql<number>`COUNT(*)` })
    .from(schema.threads)
    .where(and(
      ...filters,
      sql`${schema.threads.completedAt} IS NOT NULL`,
      gte(schema.threads.completedAt, range.start),
      lt(schema.threads.completedAt, range.end),
    ))
    .groupBy(completedBucket)
    .orderBy(completedBucket)
    .all();

  return {
    createdByDate,
    completedByDate,
    movedToPlanningByDate: stageTransitionsByDate('planning', filters, range, groupBy, tzMod),
    movedToReviewByDate: stageTransitionsByDate('review', filters, range, groupBy, tzMod),
    movedToDoneByDate: stageTransitionsByDate('done', filters, range, groupBy, tzMod),
    movedToArchivedByDate: stageTransitionsByDate('archived', filters, range, groupBy, tzMod),
    timeRange: range,
    groupBy,
  };
}
