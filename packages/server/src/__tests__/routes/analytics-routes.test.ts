/**
 * Integration tests for /api/analytics routes.
 */
import { mock } from 'bun:test';

mock.module('../../services/ws-relay.js', () => ({
  setIO: () => {},
  addRunnerClient: () => {},
  removeRunnerClient: () => {},
  isRunnerConnected: () => false,
  relayToUser: () => {},
  relayToThreadViewers: () => {},
  evictUserFromThread: () => {},
  broadcast: () => {},
  sendToRunner: () => false,
  forwardBrowserMessageToRunner: () => {},
  getAnyConnectedRunnerId: () => null,
  getConnectedBrowserUserIds: () => [],
  getRelayStats: () => ({ runners: 0, browserClients: 0 }),
}));

mock.module('../../services/ws-tunnel.js', () => ({
  setIO: () => {},
  tunnelFetch: () => Promise.reject(new Error('not available in test')),
  TunnelTimeoutError: class TunnelTimeoutError extends Error {
    name = 'TunnelTimeoutError';
  },
  isTunnelTimeoutError: () => false,
}));

import { describe, test, expect, beforeAll, beforeEach } from 'bun:test';

import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { seedProject, seedStageHistory, seedThread } from '../helpers/test-db.js';

describe('Analytics Routes (Integration)', () => {
  let t: TestApp;
  const userId = 'analytics-user';
  const recent = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();

  beforeAll(async () => {
    t = await createTestApp({ userId });
  });

  beforeEach(() => {
    t.cleanup();
  });

  describe('GET /api/analytics/overview', () => {
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

      const res = await t.requestAs(userId).get('/api/analytics/overview?timeRange=month');
      expect(res.status).toBe(200);

      const body = await res.json();
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

      const res = await t.requestAs(userId).get('/api/analytics/overview?timeRange=week');
      expect(res.status).toBe(200);

      const body = await res.json();
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

      const res = await t
        .requestAs(userId)
        .get('/api/analytics/overview?projectId=p1&timeRange=all');
      expect(res.status).toBe(200);
      expect((await res.json()).createdCount).toBe(1);
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

      const res = await t.requestAs(userId).get('/api/analytics/overview?timeRange=all');
      expect(res.status).toBe(200);
      expect((await res.json()).createdCount).toBe(0);
    });
  });

  describe('GET /api/analytics/timeline', () => {
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

      const res = await t.requestAs(userId).get('/api/analytics/timeline?timeRange=month&tz=0');
      expect(res.status).toBe(200);

      const body = await res.json();
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

      const res = await t
        .requestAs(userId)
        .get('/api/analytics/timeline?timeRange=month&groupBy=week');
      expect(res.status).toBe(200);
      expect((await res.json()).groupBy).toBe('week');
    });
  });
});
