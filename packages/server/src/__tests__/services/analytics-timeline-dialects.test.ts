/**
 * Regression test for #187: `analytics.timeline` with a timezone offset
 * answered 500 on Postgres. It runs against whichever database the process is
 * configured for (SQLite in memory by default, Postgres when `DATABASE_URL` is
 * set), and both dialects must give the same buckets.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { closeDatabase, db, dbRun, initDatabase, schema } from '../../db/index.js';
import { autoMigrate } from '../../db/migrate.js';
import { getOverview, getTimeline } from '../../services/analytics-service.js';

const userId = 'analytics-tz-user';
const projectId = 'analytics-tz-project';
// 02:00 UTC on 10 March is still 9 March in UTC-5.
const lateEvening = '2026-03-10T02:00:00.000Z';
const midday = '2026-03-10T12:00:00.000Z';
// getTimezoneOffset() for UTC-5 is 300.
const utcMinus5 = 300;

describe('analytics timeline buckets (dialect parity)', () => {
  beforeAll(async () => {
    (await initDatabase({ sqlitePath: ':memory:' }))._unsafeUnwrap();
    await autoMigrate();
    await dbRun(db.delete(schema.stageHistory));
    await dbRun(db.delete(schema.threads));
    await dbRun(db.delete(schema.projects));

    await dbRun(
      db.insert(schema.projects).values({
        id: projectId,
        name: 'Analytics TZ',
        path: '/tmp/analytics-tz',
        userId,
        sortOrder: 0,
        createdAt: midday,
      }),
    );
    for (const [id, at] of [
      ['tz-t1', lateEvening],
      ['tz-t2', midday],
    ] as const) {
      await dbRun(
        db.insert(schema.threads).values({
          id,
          projectId,
          userId,
          title: id,
          mode: 'local',
          status: 'completed',
          createdAt: at,
          updatedAt: at,
          completedAt: at,
        }),
      );
      await dbRun(
        db.insert(schema.stageHistory).values({
          id: `${id}-review`,
          threadId: id,
          fromStage: 'in_progress',
          toStage: 'review',
          changedAt: at,
        }),
      );
    }
  });

  afterAll(async () => {
    await dbRun(db.delete(schema.stageHistory));
    await dbRun(db.delete(schema.threads));
    await dbRun(db.delete(schema.projects));
    await closeDatabase();
  });

  test('day buckets follow the caller timezone', async () => {
    const timeline = await getTimeline({
      userId,
      timeRange: 'all',
      groupBy: 'day',
      offsetMinutes: utcMinus5,
    });

    const expected = [
      { date: '2026-03-09', count: 1 },
      { date: '2026-03-10', count: 1 },
    ];
    expect(timeline.createdByDate).toEqual(expected);
    expect(timeline.completedByDate).toEqual(expected);
    expect(timeline.movedToReviewByDate).toEqual(expected);
  });

  test('a timezone east of UTC moves the late-evening thread to the next day', async () => {
    // UTC+14 (offset -840): 02:00 UTC -> 16:00 on 10 March, 12:00 UTC -> 02:00 on 11 March.
    const timeline = await getTimeline({
      userId,
      timeRange: 'all',
      groupBy: 'day',
      offsetMinutes: -840,
    });

    expect(timeline.createdByDate).toEqual([
      { date: '2026-03-10', count: 1 },
      { date: '2026-03-11', count: 1 },
    ]);
  });

  test('month and year buckets', async () => {
    const month = await getTimeline({
      userId,
      timeRange: 'all',
      groupBy: 'month',
      offsetMinutes: utcMinus5,
    });
    expect(month.createdByDate).toEqual([{ date: '2026-03', count: 2 }]);

    const year = await getTimeline({
      userId,
      timeRange: 'all',
      groupBy: 'year',
      offsetMinutes: utcMinus5,
    });
    expect(year.createdByDate).toEqual([{ date: '2026', count: 2 }]);
  });

  test('week buckets answer without error', async () => {
    const week = await getTimeline({
      userId,
      timeRange: 'all',
      groupBy: 'week',
      offsetMinutes: utcMinus5,
    });
    expect(week.createdByDate.reduce((sum, row) => sum + row.count, 0)).toBe(2);
    for (const row of week.createdByDate) expect(row.date).toMatch(/^\d{4}-W\d{2}$/);
  });

  test('overview counts are numbers', async () => {
    const overview = await getOverview({ userId, timeRange: 'all', offsetMinutes: utcMinus5 });
    expect(overview.createdCount).toBe(2);
    expect(overview.completedCount).toBe(2);
    expect(overview.movedToReviewCount).toBe(2);
    expect(overview.currentStageDistribution.backlog).toBe(2);
  });
});
