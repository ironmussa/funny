/**
 * Tests for pipeline-repository.ts
 *
 * Tests pipeline CRUD and run tracking against an in-memory SQLite database.
 */
import { describe, test, expect, beforeEach } from 'bun:test';

import { eq } from 'drizzle-orm';

import { createTestDb, seedProject, seedThread, seedPipeline } from '../helpers/test-db.js';

describe('pipeline-repository', () => {
  let testDb: ReturnType<typeof createTestDb>;

  beforeEach(() => {
    testDb = createTestDb();
    seedProject(testDb.db, { id: 'p1', name: 'Project 1' });
  });

  describe('pipeline CRUD', () => {
    test('create and retrieve a pipeline', () => {
      seedPipeline(testDb.db, {
        id: 'pipe-1',
        projectId: 'p1',
        name: 'Review Pipeline',
      });

      const rows = testDb.db
        .select()
        .from(testDb.schema.pipelines)
        .where(eq(testDb.schema.pipelines.id, 'pipe-1'))
        .all();

      expect(rows).toHaveLength(1);
      expect(rows[0].name).toBe('Review Pipeline');
      expect(rows[0].projectId).toBe('p1');
      expect(rows[0].enabled).toBe(1);
    });

    test('update a pipeline', () => {
      seedPipeline(testDb.db, { id: 'pipe-2', projectId: 'p1' });

      testDb.db
        .update(testDb.schema.pipelines)
        .set({ name: 'Updated Pipeline', maxIterations: 5 })
        .where(eq(testDb.schema.pipelines.id, 'pipe-2'))
        .run();

      const updated = testDb.db
        .select()
        .from(testDb.schema.pipelines)
        .where(eq(testDb.schema.pipelines.id, 'pipe-2'))
        .get();

      expect(updated!.name).toBe('Updated Pipeline');
      expect(updated!.maxIterations).toBe(5);
    });

    test('delete a pipeline', () => {
      seedPipeline(testDb.db, { id: 'pipe-3', projectId: 'p1' });

      testDb.db
        .delete(testDb.schema.pipelines)
        .where(eq(testDb.schema.pipelines.id, 'pipe-3'))
        .run();

      const result = testDb.db
        .select()
        .from(testDb.schema.pipelines)
        .where(eq(testDb.schema.pipelines.id, 'pipe-3'))
        .get();

      expect(result).toBeUndefined();
    });

    test('list pipelines by project', () => {
      seedPipeline(testDb.db, { id: 'pipe-a', projectId: 'p1', name: 'Pipeline A' });
      seedPipeline(testDb.db, { id: 'pipe-b', projectId: 'p1', name: 'Pipeline B' });

      seedProject(testDb.db, { id: 'p2', name: 'Project 2', path: '/tmp/other' });
      seedPipeline(testDb.db, { id: 'pipe-c', projectId: 'p2', name: 'Pipeline C' });

      const p1Pipelines = testDb.db
        .select()
        .from(testDb.schema.pipelines)
        .where(eq(testDb.schema.pipelines.projectId, 'p1'))
        .all();

      expect(p1Pipelines).toHaveLength(2);
    });

    test('get enabled pipeline for project', () => {
      seedPipeline(testDb.db, {
        id: 'pipe-enabled',
        projectId: 'p1',
        enabled: 1,
        name: 'Enabled',
      });
      seedPipeline(testDb.db, {
        id: 'pipe-disabled',
        projectId: 'p1',
        enabled: 0,
        name: 'Disabled',
      });

      const rows = testDb.db
        .select()
        .from(testDb.schema.pipelines)
        .where(eq(testDb.schema.pipelines.projectId, 'p1'))
        .all();

      const enabled = rows.find((r) => r.enabled === 1);
      expect(enabled).toBeDefined();
      expect(enabled!.name).toBe('Enabled');
    });

    test('pipeline default values are correct', () => {
      seedPipeline(testDb.db, { id: 'pipe-defaults', projectId: 'p1' });

      const pipeline = testDb.db
        .select()
        .from(testDb.schema.pipelines)
        .where(eq(testDb.schema.pipelines.id, 'pipe-defaults'))
        .get();

      expect(pipeline!.reviewModel).toBe('opus');
      expect(pipeline!.fixModel).toBe('opus');
      expect(pipeline!.maxIterations).toBe(10);
      expect(pipeline!.precommitFixEnabled).toBe(0);
      expect(pipeline!.testEnabled).toBe(0);
    });
  });

  describe('pipeline runs', () => {
    test('create and retrieve a pipeline run', () => {
      seedPipeline(testDb.db, { id: 'pipe-r1', projectId: 'p1' });
      seedThread(testDb.db, { id: 't1', projectId: 'p1' });

      testDb.db
        .insert(testDb.schema.pipelineRuns)
        .values({
          id: 'run-1',
          pipelineId: 'pipe-r1',
          threadId: 't1',
          status: 'reviewing',
          currentStage: 'reviewer',
          iteration: 1,
          maxIterations: 10,
          createdAt: new Date().toISOString(),
        })
        .run();

      const run = testDb.db
        .select()
        .from(testDb.schema.pipelineRuns)
        .where(eq(testDb.schema.pipelineRuns.id, 'run-1'))
        .get();

      expect(run).toBeDefined();
      expect(run!.status).toBe('reviewing');
      expect(run!.currentStage).toBe('reviewer');
      expect(run!.iteration).toBe(1);
    });

    test('update pipeline run status and iteration', () => {
      seedPipeline(testDb.db, { id: 'pipe-r2', projectId: 'p1' });
      seedThread(testDb.db, { id: 't2', projectId: 'p1' });

      testDb.db
        .insert(testDb.schema.pipelineRuns)
        .values({
          id: 'run-2',
          pipelineId: 'pipe-r2',
          threadId: 't2',
          status: 'reviewing',
          currentStage: 'reviewer',
          iteration: 1,
          maxIterations: 10,
          createdAt: new Date().toISOString(),
        })
        .run();

      testDb.db
        .update(testDb.schema.pipelineRuns)
        .set({ status: 'fixing', currentStage: 'corrector', iteration: 2 })
        .where(eq(testDb.schema.pipelineRuns.id, 'run-2'))
        .run();

      const updated = testDb.db
        .select()
        .from(testDb.schema.pipelineRuns)
        .where(eq(testDb.schema.pipelineRuns.id, 'run-2'))
        .get();

      expect(updated!.status).toBe('fixing');
      expect(updated!.currentStage).toBe('corrector');
      expect(updated!.iteration).toBe(2);
    });

    test('list runs for a thread', () => {
      seedPipeline(testDb.db, { id: 'pipe-r3', projectId: 'p1' });
      seedThread(testDb.db, { id: 't3', projectId: 'p1' });

      testDb.db
        .insert(testDb.schema.pipelineRuns)
        .values({
          id: 'run-3a',
          pipelineId: 'pipe-r3',
          threadId: 't3',
          status: 'passed',
          currentStage: 'reviewer',
          iteration: 1,
          maxIterations: 10,
          createdAt: new Date().toISOString(),
        })
        .run();

      testDb.db
        .insert(testDb.schema.pipelineRuns)
        .values({
          id: 'run-3b',
          pipelineId: 'pipe-r3',
          threadId: 't3',
          status: 'reviewing',
          currentStage: 'reviewer',
          iteration: 1,
          maxIterations: 10,
          createdAt: new Date().toISOString(),
        })
        .run();

      const runs = testDb.db
        .select()
        .from(testDb.schema.pipelineRuns)
        .where(eq(testDb.schema.pipelineRuns.threadId, 't3'))
        .all();

      expect(runs).toHaveLength(2);
    });

    test('cascade delete removes runs when pipeline is deleted', () => {
      seedPipeline(testDb.db, { id: 'pipe-cascade', projectId: 'p1' });
      seedThread(testDb.db, { id: 't-cascade', projectId: 'p1' });

      testDb.db
        .insert(testDb.schema.pipelineRuns)
        .values({
          id: 'run-cascade',
          pipelineId: 'pipe-cascade',
          threadId: 't-cascade',
          status: 'running',
          currentStage: 'reviewer',
          iteration: 1,
          maxIterations: 5,
          createdAt: new Date().toISOString(),
        })
        .run();

      testDb.db
        .delete(testDb.schema.pipelines)
        .where(eq(testDb.schema.pipelines.id, 'pipe-cascade'))
        .run();

      const runs = testDb.db
        .select()
        .from(testDb.schema.pipelineRuns)
        .where(eq(testDb.schema.pipelineRuns.id, 'run-cascade'))
        .all();

      expect(runs).toHaveLength(0);
    });
  });
});
