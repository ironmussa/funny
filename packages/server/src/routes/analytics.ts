import { Hono } from 'hono';
import { eq, and, gte, lt, sql } from 'drizzle-orm';
import { db, schema } from '../db/index.js';

export const analyticsRoutes = new Hono();

type TimeRange = 'day' | 'week' | 'month' | 'all';
type GroupBy = 'day' | 'week' | 'month' | 'year';

/**
 * Converts a browser getTimezoneOffset() value (minutes) to an SQLite modifier
 * string. getTimezoneOffset() returns positive values for west of UTC (e.g. 300
 * for UTC-5) so we negate it before formatting.
 */
function tzOffsetToModifier(offsetMinutes: number): string {
  const total = -offsetMinutes; // flip sign: JS offset 300 → UTC-5 → -300 → '-05:00'
  const sign = total >= 0 ? '+' : '-';
  const abs = Math.abs(total);
  const h = String(Math.floor(abs / 60)).padStart(2, '0');
  const m = String(abs % 60).padStart(2, '0');
  return `${sign}${h}:${m}`;
}

/** Returns a SQL expression that buckets a date column by the requested granularity, adjusted to the user's local timezone. */
function dateBucket(column: ReturnType<typeof sql>, groupBy: GroupBy, tzMod: string) {
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

function getDateRange(timeRange?: string, offsetMinutes = 0, startDate?: string, endDate?: string) {
  // Build "now" in the user's local time so day boundaries align with their clock
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

// GET /api/analytics/overview?projectId=xxx&timeRange=month&tz=300
analyticsRoutes.get('/overview', (c) => {
  const userId = c.get('userId') as string;
  const projectId = c.req.query('projectId');
  const timeRange = c.req.query('timeRange');
  const offsetMinutes = parseInt(c.req.query('tz') || '0', 10) || 0;

  const range = getDateRange(timeRange, offsetMinutes);

  // Build base filters
  const baseFilters = [];
  if (projectId) {
    baseFilters.push(eq(schema.threads.projectId, projectId));
  }
  if (userId !== '__local__') {
    baseFilters.push(eq(schema.threads.userId, userId));
  }

  // Current stage distribution (all non-archived threads)
  const stageRows = db
    .select({
      stage: schema.threads.stage,
      count: sql<number>`COUNT(*)`,
    })
    .from(schema.threads)
    .where(and(...baseFilters, eq(schema.threads.archived, 0)))
    .groupBy(schema.threads.stage)
    .all();

  const distribution: Record<string, number> = {
    backlog: 0,
    in_progress: 0,
    review: 0,
    done: 0,
  };
  for (const row of stageRows) {
    distribution[row.stage] = row.count;
  }

  // Threads created in time range
  const createdResult = db
    .select({ count: sql<number>`COUNT(*)` })
    .from(schema.threads)
    .where(and(
      ...baseFilters,
      gte(schema.threads.createdAt, range.start),
      lt(schema.threads.createdAt, range.end),
    ))
    .get();

  // Threads completed in time range
  const completedResult = db
    .select({ count: sql<number>`COUNT(*)` })
    .from(schema.threads)
    .where(and(
      ...baseFilters,
      sql`${schema.threads.completedAt} IS NOT NULL`,
      gte(schema.threads.completedAt, range.start),
      lt(schema.threads.completedAt, range.end),
    ))
    .get();

  // Count transitions TO review within time range
  const movedToReviewResult = db
    .select({ count: sql<number>`COUNT(DISTINCT ${schema.stageHistory.threadId})` })
    .from(schema.stageHistory)
    .innerJoin(schema.threads, eq(schema.stageHistory.threadId, schema.threads.id))
    .where(and(
      ...baseFilters,
      eq(schema.stageHistory.toStage, 'review'),
      gte(schema.stageHistory.changedAt, range.start),
      lt(schema.stageHistory.changedAt, range.end),
    ))
    .get();

  // Count transitions TO done within time range
  const movedToDoneResult = db
    .select({ count: sql<number>`COUNT(DISTINCT ${schema.stageHistory.threadId})` })
    .from(schema.stageHistory)
    .innerJoin(schema.threads, eq(schema.stageHistory.threadId, schema.threads.id))
    .where(and(
      ...baseFilters,
      eq(schema.stageHistory.toStage, 'done'),
      gte(schema.stageHistory.changedAt, range.start),
      lt(schema.stageHistory.changedAt, range.end),
    ))
    .get();

  // Total cost in time range
  const costResult = db
    .select({ total: sql<number>`COALESCE(SUM(${schema.threads.cost}), 0)` })
    .from(schema.threads)
    .where(and(
      ...baseFilters,
      gte(schema.threads.createdAt, range.start),
      lt(schema.threads.createdAt, range.end),
    ))
    .get();

  return c.json({
    currentStageDistribution: distribution,
    createdCount: createdResult?.count ?? 0,
    completedCount: completedResult?.count ?? 0,
    movedToReviewCount: movedToReviewResult?.count ?? 0,
    movedToDoneCount: movedToDoneResult?.count ?? 0,
    totalCost: costResult?.total ?? 0,
    timeRange: range,
  });
});

// GET /api/analytics/timeline?projectId=xxx&timeRange=month&groupBy=week&tz=300
analyticsRoutes.get('/timeline', (c) => {
  const userId = c.get('userId') as string;
  const projectId = c.req.query('projectId');
  const timeRange = c.req.query('timeRange');
  const groupBy = (c.req.query('groupBy') || 'day') as GroupBy;
  const offsetMinutes = parseInt(c.req.query('tz') || '0', 10) || 0;
  const tzMod = tzOffsetToModifier(offsetMinutes);

  const range = getDateRange(timeRange, offsetMinutes);

  const baseFilters = [];
  if (projectId) {
    baseFilters.push(eq(schema.threads.projectId, projectId));
  }
  if (userId !== '__local__') {
    baseFilters.push(eq(schema.threads.userId, userId));
  }

  // Tasks created by date
  const dateBucketCreated = dateBucket(schema.threads.createdAt, groupBy, tzMod);
  const createdByDate = db
    .select({
      date: dateBucketCreated.as('date'),
      count: sql<number>`COUNT(*)`,
    })
    .from(schema.threads)
    .where(and(
      ...baseFilters,
      gte(schema.threads.createdAt, range.start),
      lt(schema.threads.createdAt, range.end),
    ))
    .groupBy(dateBucketCreated)
    .orderBy(dateBucketCreated)
    .all();

  // Tasks completed by date
  const dateBucketCompleted = dateBucket(schema.threads.completedAt, groupBy, tzMod);
  const completedByDate = db
    .select({
      date: dateBucketCompleted.as('date'),
      count: sql<number>`COUNT(*)`,
    })
    .from(schema.threads)
    .where(and(
      ...baseFilters,
      sql`${schema.threads.completedAt} IS NOT NULL`,
      gte(schema.threads.completedAt, range.start),
      lt(schema.threads.completedAt, range.end),
    ))
    .groupBy(dateBucketCompleted)
    .orderBy(dateBucketCompleted)
    .all();

  // Tasks moved to review by date
  const dateBucketReview = dateBucket(schema.stageHistory.changedAt, groupBy, tzMod);
  const movedToReviewByDate = db
    .select({
      date: dateBucketReview.as('date'),
      count: sql<number>`COUNT(DISTINCT ${schema.stageHistory.threadId})`,
    })
    .from(schema.stageHistory)
    .innerJoin(schema.threads, eq(schema.stageHistory.threadId, schema.threads.id))
    .where(and(
      ...baseFilters,
      eq(schema.stageHistory.toStage, 'review'),
      gte(schema.stageHistory.changedAt, range.start),
      lt(schema.stageHistory.changedAt, range.end),
    ))
    .groupBy(dateBucketReview)
    .orderBy(dateBucketReview)
    .all();

  // Tasks moved to done by date
  const dateBucketDone = dateBucket(schema.stageHistory.changedAt, groupBy, tzMod);
  const movedToDoneByDate = db
    .select({
      date: dateBucketDone.as('date'),
      count: sql<number>`COUNT(DISTINCT ${schema.stageHistory.threadId})`,
    })
    .from(schema.stageHistory)
    .innerJoin(schema.threads, eq(schema.stageHistory.threadId, schema.threads.id))
    .where(and(
      ...baseFilters,
      eq(schema.stageHistory.toStage, 'done'),
      gte(schema.stageHistory.changedAt, range.start),
      lt(schema.stageHistory.changedAt, range.end),
    ))
    .groupBy(dateBucketDone)
    .orderBy(dateBucketDone)
    .all();

  return c.json({
    createdByDate,
    completedByDate,
    movedToReviewByDate,
    movedToDoneByDate,
    timeRange: range,
    groupBy,
  });
});
