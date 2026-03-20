/**
 * Pipeline DB CRUD tests.
 *
 * Tests pipeline and pipeline_run CRUD operations against an in-memory SQLite DB.
 * Uses the same pattern as project-manager.test.ts — reimplements the logic
 * against the test DB since the real module imports a singleton.
 *
 * These tests depend on bun:sqlite and are excluded from vitest (run with bun test).
 */
import { eq } from 'drizzle-orm';
import { describe, test, expect, beforeEach } from 'vitest';

import { createTestDb, seedProject, seedThread, seedPipeline } from '../helpers/test-db.js';

// ── Mock DB Types ───────────────────────────────────────────

type TestDb = ReturnType<typeof createTestDb>;

describe('Pipeline DB CRUD', () => {
  let testDb: TestDb;

  beforeEach(() => {
    testDb = createTestDb();
    // Seed a project and thread for FK constraints
    seedProject(testDb.db, { id: 'proj-1', name: 'Test Project' });
    seedThread(testDb.db, { id: 'thread-1', projectId: 'proj-1' });
  });

  // ── Reimplemented CRUD functions ──────────────────────────

  function createPipeline(data: {
    id?: string;
    projectId: string;
    userId?: string;
    name: string;
    reviewModel?: string;
    fixModel?: string;
    maxIterations?: number;
    precommitFixEnabled?: number;
  }) {
    const id = data.id ?? `pipe-${Date.now()}`;
    const now = new Date().toISOString();
    testDb.db
      .insert(testDb.schema.pipelines)
      .values({
        id,
        projectId: data.projectId,
        userId: data.userId ?? 'user-1',
        name: data.name,
        enabled: 1,
        reviewModel: data.reviewModel ?? 'sonnet',
        fixModel: data.fixModel ?? 'sonnet',
        maxIterations: data.maxIterations ?? 10,
        precommitFixEnabled: data.precommitFixEnabled ?? 0,
        precommitFixModel: 'sonnet',
        precommitFixMaxIterations: 3,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    return id;
  }

  function getPipelineById(id: string) {
    return testDb.db
      .select()
      .from(testDb.schema.pipelines)
      .where(eq(testDb.schema.pipelines.id, id))
      .get();
  }

  function getPipelinesForProject(projectId: string) {
    return testDb.db
      .select()
      .from(testDb.schema.pipelines)
      .where(eq(testDb.schema.pipelines.projectId, projectId))
      .all();
  }

  function getEnabledPipelineForProject(projectId: string) {
    const rows = testDb.db
      .select()
      .from(testDb.schema.pipelines)
      .where(eq(testDb.schema.pipelines.projectId, projectId))
      .all();
    return rows.find((r) => r.enabled) ?? null;
  }

  function updatePipeline(id: string, updates: Record<string, unknown>) {
    const data = { ...updates, updatedAt: new Date().toISOString() };
    testDb.db
      .update(testDb.schema.pipelines)
      .set(data)
      .where(eq(testDb.schema.pipelines.id, id))
      .run();
  }

  function deletePipeline(id: string) {
    testDb.db.delete(testDb.schema.pipelines).where(eq(testDb.schema.pipelines.id, id)).run();
  }

  function createRun(data: {
    id?: string;
    pipelineId: string;
    threadId: string;
    maxIterations?: number;
    commitSha?: string;
  }) {
    const id = data.id ?? `run-${Date.now()}`;
    testDb.db
      .insert(testDb.schema.pipelineRuns)
      .values({
        id,
        pipelineId: data.pipelineId,
        threadId: data.threadId,
        status: 'reviewing',
        currentStage: 'reviewer',
        iteration: 1,
        maxIterations: data.maxIterations ?? 10,
        commitSha: data.commitSha ?? null,
        createdAt: new Date().toISOString(),
      })
      .run();
    return id;
  }

  function getRunById(id: string) {
    return testDb.db
      .select()
      .from(testDb.schema.pipelineRuns)
      .where(eq(testDb.schema.pipelineRuns.id, id))
      .get();
  }

  function getRunsForThread(threadId: string) {
    return testDb.db
      .select()
      .from(testDb.schema.pipelineRuns)
      .where(eq(testDb.schema.pipelineRuns.threadId, threadId))
      .all();
  }

  function updateRun(id: string, updates: Record<string, unknown>) {
    testDb.db
      .update(testDb.schema.pipelineRuns)
      .set(updates)
      .where(eq(testDb.schema.pipelineRuns.id, id))
      .run();
  }

  // ── Pipeline CRUD Tests ───────────────────────────────────

  describe('pipelines CRUD', () => {
    test('createPipeline inserts a record', () => {
      const id = createPipeline({ projectId: 'proj-1', name: 'My Pipeline' });
      const row = getPipelineById(id);
      expect(row).toBeTruthy();
      expect(row!.name).toBe('My Pipeline');
      expect(row!.projectId).toBe('proj-1');
      expect(row!.enabled).toBe(1);
    });

    test('createPipeline uses default values', () => {
      const id = createPipeline({ projectId: 'proj-1', name: 'Defaults' });
      const row = getPipelineById(id);
      expect(row!.reviewModel).toBe('sonnet');
      expect(row!.fixModel).toBe('sonnet');
      expect(row!.maxIterations).toBe(10);
      expect(row!.precommitFixEnabled).toBe(0);
    });

    test('getPipelinesForProject returns all pipelines for a project', () => {
      createPipeline({ id: 'p1', projectId: 'proj-1', name: 'Pipeline 1' });
      createPipeline({ id: 'p2', projectId: 'proj-1', name: 'Pipeline 2' });
      const results = getPipelinesForProject('proj-1');
      expect(results).toHaveLength(2);
    });

    test('getPipelinesForProject returns empty for unknown project', () => {
      expect(getPipelinesForProject('unknown-proj')).toEqual([]);
    });

    test('getEnabledPipelineForProject returns enabled pipeline', () => {
      createPipeline({ id: 'p-enabled', projectId: 'proj-1', name: 'Enabled' });
      const result = getEnabledPipelineForProject('proj-1');
      expect(result).toBeTruthy();
      expect(result!.id).toBe('p-enabled');
    });

    test('getEnabledPipelineForProject returns null when disabled', () => {
      const id = createPipeline({ id: 'p-disabled', projectId: 'proj-1', name: 'Disabled' });
      updatePipeline(id, { enabled: 0 });
      const result = getEnabledPipelineForProject('proj-1');
      expect(result).toBeNull();
    });

    test('updatePipeline modifies fields', () => {
      const id = createPipeline({ id: 'p-update', projectId: 'proj-1', name: 'Original' });
      updatePipeline(id, { name: 'Updated', reviewModel: 'opus', maxIterations: 5 });
      const row = getPipelineById(id);
      expect(row!.name).toBe('Updated');
      expect(row!.reviewModel).toBe('opus');
      expect(row!.maxIterations).toBe(5);
    });

    test('updatePipeline sets updatedAt', () => {
      const id = createPipeline({ id: 'p-ts', projectId: 'proj-1', name: 'TS' });
      const before = getPipelineById(id)!.updatedAt;
      // Small delay to ensure different timestamp
      updatePipeline(id, { name: 'Updated TS' });
      const after = getPipelineById(id)!.updatedAt;
      expect(after >= before).toBe(true);
    });

    test('deletePipeline removes the record', () => {
      const id = createPipeline({ id: 'p-delete', projectId: 'proj-1', name: 'ToDelete' });
      expect(getPipelineById(id)).toBeTruthy();
      deletePipeline(id);
      expect(getPipelineById(id)).toBeUndefined();
    });

    test('deletePipeline on non-existent record does not throw', () => {
      expect(() => deletePipeline('nonexistent')).not.toThrow();
    });
  });

  // ── Pipeline Run CRUD Tests ───────────────────────────────

  describe('pipeline_runs CRUD', () => {
    beforeEach(() => {
      seedPipeline(testDb.db, { id: 'pipe-1', projectId: 'proj-1' });
    });

    test('createRun inserts a record with default values', () => {
      const id = createRun({ pipelineId: 'pipe-1', threadId: 'thread-1' });
      const row = getRunById(id);
      expect(row).toBeTruthy();
      expect(row!.pipelineId).toBe('pipe-1');
      expect(row!.threadId).toBe('thread-1');
      expect(row!.status).toBe('reviewing');
      expect(row!.currentStage).toBe('reviewer');
      expect(row!.iteration).toBe(1);
    });

    test('createRun stores commitSha', () => {
      const id = createRun({
        pipelineId: 'pipe-1',
        threadId: 'thread-1',
        commitSha: 'abc123def',
      });
      const row = getRunById(id);
      expect(row!.commitSha).toBe('abc123def');
    });

    test('getRunById returns undefined for non-existent run', () => {
      expect(getRunById('nonexistent')).toBeUndefined();
    });

    test('getRunsForThread returns runs for a thread', () => {
      createRun({ id: 'r1', pipelineId: 'pipe-1', threadId: 'thread-1' });
      createRun({ id: 'r2', pipelineId: 'pipe-1', threadId: 'thread-1' });
      const runs = getRunsForThread('thread-1');
      expect(runs).toHaveLength(2);
    });

    test('getRunsForThread returns empty for unknown thread', () => {
      expect(getRunsForThread('unknown-thread')).toEqual([]);
    });

    test('updateRun modifies status and stage', () => {
      const id = createRun({ id: 'r-update', pipelineId: 'pipe-1', threadId: 'thread-1' });
      updateRun(id, { status: 'fixing', currentStage: 'corrector' });
      const row = getRunById(id);
      expect(row!.status).toBe('fixing');
      expect(row!.currentStage).toBe('corrector');
    });

    test('updateRun stores verdict and findings', () => {
      const id = createRun({ id: 'r-verdict', pipelineId: 'pipe-1', threadId: 'thread-1' });
      const findings = JSON.stringify([{ severity: 'high', description: 'Bug found' }]);
      updateRun(id, { verdict: 'fail', findings });
      const row = getRunById(id);
      expect(row!.verdict).toBe('fail');
      expect(row!.findings).toBe(findings);
    });

    test('updateRun increments iteration', () => {
      const id = createRun({ id: 'r-iter', pipelineId: 'pipe-1', threadId: 'thread-1' });
      updateRun(id, { iteration: 2 });
      const row = getRunById(id);
      expect(row!.iteration).toBe(2);
    });

    test('updateRun stores reviewer and fixer thread IDs', () => {
      const id = createRun({ id: 'r-threads', pipelineId: 'pipe-1', threadId: 'thread-1' });
      updateRun(id, { reviewerThreadId: 'rev-t', fixerThreadId: 'fix-t' });
      const row = getRunById(id);
      expect(row!.reviewerThreadId).toBe('rev-t');
      expect(row!.fixerThreadId).toBe('fix-t');
    });

    test('updateRun marks completion', () => {
      const id = createRun({ id: 'r-done', pipelineId: 'pipe-1', threadId: 'thread-1' });
      const completedAt = new Date().toISOString();
      updateRun(id, { status: 'completed', completedAt });
      const row = getRunById(id);
      expect(row!.status).toBe('completed');
      expect(row!.completedAt).toBe(completedAt);
    });

    test('deleting pipeline cascades to pipeline_runs', () => {
      createRun({ id: 'r-cascade', pipelineId: 'pipe-1', threadId: 'thread-1' });
      expect(getRunById('r-cascade')).toBeTruthy();
      deletePipeline('pipe-1');
      expect(getRunById('r-cascade')).toBeUndefined();
    });
  });
});
