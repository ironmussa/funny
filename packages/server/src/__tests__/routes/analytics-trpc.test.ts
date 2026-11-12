/**
 * Integration tests for the `analytics` tRPC procedures (the REST
 * `/api/analytics/*` routes were removed in openspec adopt-trpc-browser-api,
 * task 6.1): stage distribution, time-range and project filters, per-user
 * scoping and timeline buckets.
 */
import { describe, test, expect, beforeAll, beforeEach } from 'bun:test';

import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { seedProject, seedStageHistory, seedThread } from '../helpers/test-db.js';

describe('analytics over tRPC (integration)', () => {
  let t: TestApp;
  const userId = 'analytics-user';
  const recent = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();

  /** GET a tRPC query as `userId`; answers `{ status, body }` with the data unwrapped. */
  const query = async (path: string, input: Record<string, unknown>) => {
    const qs = `?input=${encodeURIComponent(JSON.stringify(input))}`;
    const res = await t.app.request(`/api/trpc/${path}${qs}`, {
      headers: { 'X-Test-User-Id': userId },
    });
    const json = (await res.json()) as any;
    return { status: res.status, body: json.result?.data };
  };

  beforeAll(async () => {
    t = await createTestApp({ userId });
  });

  beforeEach(() => {
    t.cleanup();
  });

  describe('analytics.overview', () => {
    test('returns stage distribution and activity counts for the caller', async () => {
      seedProject(t.db as any, { id: 'p1', userId, path: '/repo-a' });
      seedThread(t.db as any, {
        id: 't-planning',
        projectId: 'p1',
        userId,
        stage: 'planning',
        cost: 2.5,
        createdAt: recent,
        updatedAt: recent,
      });
      seedThread(t.db as any, {
        id: 't-done',
        projectId: 'p1',
        userId,
        stage: 'done',
        archived: 1,
        cost: 1.0,
        createdAt: recent,
        updatedAt: recent,
        completedAt: recent,
      });
      seedStageHistory(t.db as any, {
        threadId: 't-planning',
        fromStage: 'backlog',
        toStage: 'planning',
        changedAt: recent,
      });
      seedStageHistory(t.db as any, {
        threadId: 't-done',
        fromStage: 'review',
        toStage: 'done',
        changedAt: recent,
      });

      const res = await query('analytics.overview', { timeRange: 'month' });
      expect(res.status).toBe(200);

      const body = res.body;
      expect(body.currentStageDistribution.planning).toBe(1);
      expect(body.currentStageDistribution.archived).toBe(1);
      expect(body.createdCount).toBe(2);
      expect(body.completedCount).toBe(1);
      expect(body.movedToPlanningCount).toBe(1);
      expect(body.movedToDoneCount).toBe(1);
      expect(body.totalCost).toBe(3.5);
      expect(body.timeRange.start).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(body.timeRange.end).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    test('stage distribution is scoped to the selected time range', async () => {
      const old = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
      seedProject(t.db as any, { id: 'p1', userId, path: '/repo-a' });
      // In-range thread — should be counted
      seedThread(t.db as any, {
        id: 't-recent',
        projectId: 'p1',
        userId,
        stage: 'review',
        createdAt: recent,
        updatedAt: recent,
      });
      // Out-of-range thread — must be excluded from the distribution
      seedThread(t.db as any, {
        id: 't-old',
        projectId: 'p1',
        userId,
        stage: 'review',
        createdAt: old,
        updatedAt: old,
      });
      seedThread(t.db as any, {
        id: 't-old-archived',
        projectId: 'p1',
        userId,
        stage: 'done',
        archived: 1,
        createdAt: old,
        updatedAt: old,
      });

      const res = await query('analytics.overview', { timeRange: 'week' });
      expect(res.status).toBe(200);

      const body = res.body;
      expect(body.currentStageDistribution.review).toBe(1); // only the recent one
      expect(body.currentStageDistribution.archived).toBe(0); // old archived excluded
    });

    test('filters by projectId', async () => {
      seedProject(t.db as any, { id: 'p1', userId, path: '/repo-a' });
      seedProject(t.db as any, { id: 'p2', userId, path: '/repo-b' });
      seedThread(t.db as any, {
        id: 't1',
        projectId: 'p1',
        userId,
        createdAt: recent,
        updatedAt: recent,
      });
      seedThread(t.db as any, {
        id: 't2',
        projectId: 'p2',
        userId,
        createdAt: recent,
        updatedAt: recent,
      });

      const res = await query('analytics.overview', { projectId: 'p1', timeRange: 'all' });
      expect(res.status).toBe(200);
      expect(res.body.createdCount).toBe(1);
    });

    test('does not include other users threads', async () => {
      seedProject(t.db as any, { id: 'p1', userId: 'other-user', path: '/other' });
      seedThread(t.db as any, {
        id: 't-other',
        projectId: 'p1',
        userId: 'other-user',
        createdAt: recent,
        updatedAt: recent,
      });

      const res = await query('analytics.overview', { timeRange: 'all' });
      expect(res.status).toBe(200);
      expect(res.body.createdCount).toBe(0);
    });
  });

  describe('analytics.timeline', () => {
    test('returns bucketed series with default groupBy=day', async () => {
      seedProject(t.db as any, { id: 'p1', userId, path: '/repo-a' });
      seedThread(t.db as any, {
        id: 't1',
        projectId: 'p1',
        userId,
        createdAt: recent,
        updatedAt: recent,
        completedAt: recent,
      });
      seedStageHistory(t.db as any, {
        threadId: 't1',
        fromStage: 'in_progress',
        toStage: 'review',
        changedAt: recent,
      });

      const res = await query('analytics.timeline', { timeRange: 'month', tz: 0 });
      expect(res.status).toBe(200);

      const body = res.body;
      expect(body.groupBy).toBe('day');
      expect(Array.isArray(body.createdByDate)).toBe(true);
      expect(Array.isArray(body.completedByDate)).toBe(true);
      expect(Array.isArray(body.movedToReviewByDate)).toBe(true);
      expect(body.createdByDate.length).toBeGreaterThan(0);
      expect(body.completedByDate.length).toBeGreaterThan(0);
      expect(body.movedToReviewByDate.length).toBeGreaterThan(0);
      expect(body.timeRange.start).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    test('honors groupBy=week query param', async () => {
      seedProject(t.db as any, { id: 'p1', userId, path: '/repo-a' });
      seedThread(t.db as any, {
        id: 't1',
        projectId: 'p1',
        userId,
        createdAt: recent,
        updatedAt: recent,
      });

      const res = await query('analytics.timeline', { timeRange: 'month', groupBy: 'week' });
      expect(res.status).toBe(200);
      expect(res.body.groupBy).toBe('week');
    });
  });
});
