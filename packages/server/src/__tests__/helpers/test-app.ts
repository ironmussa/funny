/**
 * Integration test helper for server route tests.
 *
 * Creates a Hono app with:
 * - In-memory SQLite database (full schema via migrations)
 * - Mock auth middleware (sets userId, userRole, etc. from headers)
 * - Real server routes mounted at their actual paths
 *
 * Usage:
 *   const { app, db, schema, requestAs, cleanup } = await createTestApp();
 */

import { sql } from 'drizzle-orm';
import { Hono } from 'hono';

import type { AppDatabase } from '../../db/index.js';
import type { ServerEnv } from '../../lib/types.js';

// ── Types ──────────────────────────────────────────────

export interface TestAppOptions {
  /** Default userId for all requests (overridable per-request via header) */
  userId?: string;
  /** Default userRole ('user' | 'admin') */
  userRole?: string;
}

export interface TestApp {
  app: Hono<ServerEnv>;
  db: AppDatabase;
  schema: typeof import('../../db/schema.js');
  /** Make requests as a specific user */
  requestAs: (
    userId: string,
    role?: string,
  ) => {
    get: (path: string) => Promise<Response>;
    post: (path: string, body?: any) => Promise<Response>;
    patch: (path: string, body?: any) => Promise<Response>;
    put: (path: string, body?: any) => Promise<Response>;
    delete: (path: string) => Promise<Response>;
  };
  /** Truncate all tables for test isolation */
  cleanup: () => void;
}

// ── Initialization ─────────────────────────────────────

export async function createTestApp(opts: TestAppOptions = {}): Promise<TestApp> {
  // 1. Initialize the singleton DB with in-memory SQLite
  const { initDatabase } = await import('../../db/index.js');
  await initDatabase({ sqlitePath: ':memory:' });

  // 2. Run all migrations to create the full schema
  const { autoMigrate } = await import('../../db/migrate.js');
  await autoMigrate();

  // 3. Import the singleton db (backed by our :memory: DB)
  const dbModule = await import('../../db/index.js');
  const schema = await import('../../db/schema.js');
  const db = dbModule.db;

  // 4. Create Hono app with mock auth middleware
  const app = new Hono<ServerEnv>();

  app.use('*', async (c, next) => {
    c.set('userId', c.req.header('X-Test-User-Id') ?? opts.userId ?? 'test-user-1');
    c.set('userRole', c.req.header('X-Test-User-Role') ?? opts.userRole ?? 'user');
    c.set('isRunner', c.req.header('X-Test-Is-Runner') === 'true');
    c.set('runnerId', c.req.header('X-Test-Runner-Id') ?? '');
    c.set('organizationId', c.req.header('X-Test-Org-Id') ?? null);
    c.set('organizationName', c.req.header('X-Test-Org-Name') ?? null);
    return next();
  });

  // 5. Mount real route modules
  const { projectRoutes } = await import('../../routes/projects.js');
  const { runnerRoutes } = await import('../../routes/runners.js');
  const { threadRoutes } = await import('../../routes/threads.js');
  const { settingsRoutes } = await import('../../routes/settings.js');
  const { profileRoutes } = await import('../../routes/profile.js');

  app.route('/api/projects', projectRoutes);
  app.route('/api/runners', runnerRoutes);
  app.route('/api/threads', threadRoutes);
  app.route('/api/settings', settingsRoutes);
  app.route('/api/profile', profileRoutes);

  // 6. Build helpers
  const cleanup = () => {
    // Truncate all tables in reverse dependency order
    const tables = [
      'tool_calls',
      'messages',
      'thread_comments',
      'stage_history',
      'message_queue',
      'thread_events',
      'pipeline_runs',
      'pipelines',
      'automation_runs',
      'automations',
      'runner_tasks',
      'runner_project_assignments',
      'threads',
      'team_projects',
      'project_members',
      'projects',
      'runners',
      'user_profiles',
      'instance_settings',
    ];
    for (const table of tables) {
      try {
        (db as any).run(sql.raw(`DELETE FROM ${table}`));
      } catch {
        // Table may not exist — skip
      }
    }
  };

  const requestAs = (userId: string, role = 'user') => ({
    get: (path: string) =>
      app.request(path, {
        headers: { 'X-Test-User-Id': userId, 'X-Test-User-Role': role },
      }),
    post: (path: string, body?: any) =>
      app.request(path, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Test-User-Id': userId,
          'X-Test-User-Role': role,
        },
        body: body ? JSON.stringify(body) : undefined,
      }),
    patch: (path: string, body?: any) =>
      app.request(path, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'X-Test-User-Id': userId,
          'X-Test-User-Role': role,
        },
        body: body ? JSON.stringify(body) : undefined,
      }),
    put: (path: string, body?: any) =>
      app.request(path, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'X-Test-User-Id': userId,
          'X-Test-User-Role': role,
        },
        body: body ? JSON.stringify(body) : undefined,
      }),
    delete: (path: string) =>
      app.request(path, {
        method: 'DELETE',
        headers: { 'X-Test-User-Id': userId, 'X-Test-User-Role': role },
      }),
  });

  return { app, db, schema, requestAs, cleanup };
}
