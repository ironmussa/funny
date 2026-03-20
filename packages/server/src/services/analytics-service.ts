/**
 * @domain subdomain: Analytics
 * @domain subdomain-type: generic
 * @domain type: app-service
 * @domain layer: application
 * @domain depends: Database
 *
 * Query logic for overview and timeline analytics.
 */

import { eq, and, gte, lt, sql } from 'drizzle-orm';

import { db, dbAll, dbGet, schema } from '../db/index.js';

type TimeRange = 'day' | 'week' | 'month' | 'all';
type GroupBy = 'day' | 'week' | 'month' | 'year';

/**
 * Converts a browser getTimezoneOffset() value (minutes) to an SQLite modifier
 * string. getTimezoneOffset() returns positive values for west of UTC (e.g. 300
 * for UTC-5) so we negate it before formatting.
 */
export function tzOffsetToModifier(offsetMinutes: number): string {
  const total = -offsetMinutes;
  const sign = total >= 0 ? '+' : '-';
  const abs = Math.abs(total);
  const h = String(Math.floor(abs / 60)).padStart(2, '0');
  const m = String(abs % 60).padStart(2, '0');
  return `${sign}${h}:${m}`;
}

/** Returns a SQL expression that buckets a date column by the requested granularity (SQLite). */
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

export function getDateRange(
  timeRange?: string,
  _offsetMinutes = 0,
  startDate?: string,
  endDate?: string,
) {
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
async function countTransitionsTo(
  stage: string,
  baseFilters: ReturnType<typeof eq>[],
  range: { start: string; end: string },
) {
  const result = await dbGet(
    db
      .select({ count: sql<number>`COUNT(DISTINCT ${schema.stageHistory.threadId})` })
      .from(schema.stageHistory)
      .innerJoin(schema.threads, eq(schema.stageHistory.threadId, schema.threads.id))
      .where(
        and(
          ...baseFilters,
          eq(schema.stageHistory.toStage, stage),
          gte(schema.stageHistory.changedAt, range.start),
          lt(schema.stageHistory.changedAt, range.end),
        ),
      ),
  );
  return result?.count ?? 0;
}

// ── Public API ──────────────────────────────────────────────────

export interface OverviewParams {
  userId: string;
  projectId?: string;
  timeRange?: string;
  offsetMinutes?: number;
}

export async function getOverview(params: OverviewParams) {
  const { userId, projectId, timeRange, offsetMinutes = 0 } = params;
  const range = getDateRange(timeRange, offsetMinutes);
  const filters = baseFiltersFor({ projectId, userId });

  // Current stage distribution (non-archived threads by stage)
  const stageRows = await dbAll(
    (db as any)
      .select({
        stage: schema.threads.stage,
        count: sql<number>`COUNT(*)`,
      })
      .from(schema.threads)
      .where(and(...filters, eq(schema.threads.archived, 0)))
      .groupBy(schema.threads.stage),
  );

  const archivedResult = await dbGet(
    db
      .select({ count: sql<number>`COUNT(*)` })
      .from(schema.threads)
      .where(and(...filters, eq(schema.threads.archived, 1))),
  );

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
  const createdResult = await dbGet(
    db
      .select({ count: sql<number>`COUNT(*)` })
      .from(schema.threads)
      .where(
        and(
          ...filters,
          gte(schema.threads.createdAt, range.start),
          lt(schema.threads.createdAt, range.end),
        ),
      ),
  );

  // Threads completed in time range
  const completedResult = await dbGet(
    db
      .select({ count: sql<number>`COUNT(*)` })
      .from(schema.threads)
      .where(
        and(
          ...filters,
          sql`${schema.threads.completedAt} IS NOT NULL`,
          gte(schema.threads.completedAt, range.start),
          lt(schema.threads.completedAt, range.end),
        ),
      ),
  );

  const totalCostResult = await dbGet(
    db
      .select({ total: sql<number>`COALESCE(SUM(${schema.threads.cost}), 0)` })
      .from(schema.threads)
      .where(
        and(
          ...filters,
          gte(schema.threads.createdAt, range.start),
          lt(schema.threads.createdAt, range.end),
        ),
      ),
  );

  return {
    currentStageDistribution: distribution,
    createdCount: createdResult?.count ?? 0,
    completedCount: completedResult?.count ?? 0,
    movedToPlanningCount: await countTransitionsTo('planning', filters, range),
    movedToReviewCount: await countTransitionsTo('review', filters, range),
    movedToDoneCount: await countTransitionsTo('done', filters, range),
    movedToArchivedCount: await countTransitionsTo('archived', filters, range),
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
async function stageTransitionsByDate(
  stage: string,
  baseFilters: ReturnType<typeof eq>[],
  range: { start: string; end: string },
  groupBy: GroupBy,
  tzMod: string,
) {
  const bucket = dateBucket(schema.stageHistory.changedAt, groupBy, tzMod);
  return dbAll(
    db
      .select({
        date: bucket.as('date'),
        count: sql<number>`COUNT(DISTINCT ${schema.stageHistory.threadId})`,
      })
      .from(schema.stageHistory)
      .innerJoin(schema.threads, eq(schema.stageHistory.threadId, schema.threads.id))
      .where(
        and(
          ...baseFilters,
          eq(schema.stageHistory.toStage, stage),
          gte(schema.stageHistory.changedAt, range.start),
          lt(schema.stageHistory.changedAt, range.end),
        ),
      )
      .groupBy(bucket)
      .orderBy(bucket),
  );
}

export async function getTimeline(params: TimelineParams) {
  const { userId, projectId, timeRange, groupBy: gb = 'day', offsetMinutes = 0 } = params;
  const groupBy = gb as GroupBy;
  const tzMod = tzOffsetToModifier(offsetMinutes);
  const range = getDateRange(timeRange, offsetMinutes);
  const filters = baseFiltersFor({ projectId, userId });

  // Tasks created by date
  const createdBucket = dateBucket(schema.threads.createdAt, groupBy, tzMod);
  const createdByDate = await dbAll(
    db
      .select({ date: createdBucket.as('date'), count: sql<number>`COUNT(*)` })
      .from(schema.threads)
      .where(
        and(
          ...filters,
          gte(schema.threads.createdAt, range.start),
          lt(schema.threads.createdAt, range.end),
        ),
      )
      .groupBy(createdBucket)
      .orderBy(createdBucket),
  );

  // Tasks completed by date
  const completedBucket = dateBucket(schema.threads.completedAt, groupBy, tzMod);
  const completedByDate = await dbAll(
    db
      .select({ date: completedBucket.as('date'), count: sql<number>`COUNT(*)` })
      .from(schema.threads)
      .where(
        and(
          ...filters,
          sql`${schema.threads.completedAt} IS NOT NULL`,
          gte(schema.threads.completedAt, range.start),
          lt(schema.threads.completedAt, range.end),
        ),
      )
      .groupBy(completedBucket)
      .orderBy(completedBucket),
  );

  return {
    createdByDate,
    completedByDate,
    movedToPlanningByDate: await stageTransitionsByDate('planning', filters, range, groupBy, tzMod),
    movedToReviewByDate: await stageTransitionsByDate('review', filters, range, groupBy, tzMod),
    movedToDoneByDate: await stageTransitionsByDate('done', filters, range, groupBy, tzMod),
    movedToArchivedByDate: await stageTransitionsByDate('archived', filters, range, groupBy, tzMod),
    timeRange: range,
    groupBy,
  };
}
