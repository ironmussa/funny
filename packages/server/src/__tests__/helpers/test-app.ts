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
  userRole?: 'user' | 'admin';
}

export interface TestApp {
  app: Hono<ServerEnv>;
  db: AppDatabase;
  schema: typeof import('../../db/schema.js');
  /** Make requests as a specific user */
  requestAs: (
    userId: string,
    role?: 'user' | 'admin',
    extras?: { orgId?: string },
  ) => {
    get: (path: string) => Promise<Response>;
    post: (path: string, body?: any) => Promise<Response>;
    patch: (path: string, body?: any) => Promise<Response>;
    put: (path: string, body?: any) => Promise<Response>;
    delete: (path: string) => Promise<Response>;
  };
  /** Make runner-authenticated requests (heartbeat, tasks, etc.) */
  requestAsRunner: (runnerId: string) => {
    get: (path: string) => Promise<Response>;
    post: (path: string, body?: any) => Promise<Response>;
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
    const userRole =
      c.req.header('X-Test-User-Role') === 'admin' ? 'admin' : (opts.userRole ?? 'user');
    c.set('userRole', userRole);
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
  const { shareRoutes } = await import('../../routes/thread-shares.js');
  const { settingsRoutes } = await import('../../routes/settings.js');
  const { profileRoutes } = await import('../../routes/profile.js');
  const { orchestratorRoutes } = await import('../../routes/orchestrator.js');
  const { teamSettingsRoutes } = await import('../../routes/team-settings.js');
  const { teamProjectRoutes } = await import('../../routes/team-projects.js');
  const { analyticsRoutes } = await import('../../routes/analytics.js');
  const { inviteLinkPublicRoutes, inviteLinkRoutes } = await import('../../routes/invite-links.js');
  const { automationRoutes } = await import('../../routes/automations.js');
  const { pipelineRoutes } = await import('../../routes/pipelines.js');
  const { orchestratorSystemRoutes } = await import('../../routes/orchestrator-system.js');
  const { userRoutes } = await import('../../routes/users.js');

  app.route('/api/projects', projectRoutes);
  app.route('/api/users', userRoutes);
  app.route('/api/runners', runnerRoutes);
  app.route('/api/threads', shareRoutes);
  app.route('/api/threads', threadRoutes);
  app.route('/api/settings', settingsRoutes);
  app.route('/api/profile', profileRoutes);
  app.route('/api/orchestrator', orchestratorRoutes);
  app.route('/api/orchestrator/system', orchestratorSystemRoutes);
  app.route('/api/team-settings', teamSettingsRoutes);
  app.route('/api/team-projects', teamProjectRoutes);
  app.route('/api/analytics', analyticsRoutes);
  app.route('/api/automations', automationRoutes);
  app.route('/api/pipelines', pipelineRoutes);
  app.route('/api/invite-links', inviteLinkPublicRoutes);
  app.route('/api/invite-links', inviteLinkRoutes);

  // 6. Build helpers
  const cleanup = () => {
    // Truncate all tables in reverse dependency order
    const tables = [
      'tool_calls',
      'messages',
      'thread_comments',
      'thread_shares',
      'resource_grants',
      'project_member_config',
      'stage_history',
      'message_queue',
      'thread_events',
      'pipeline_runs',
      'pipelines',
      'automation_runs',
      'automations',
      'runner_tasks',
      'runner_project_assignments',
      'runner_enrollments',
      'project_agent_profile_bindings',
      'agent_execution_profiles',
      'threads',
      'team_projects',
      'project_members',
      'projects',
      'runners',
      'orchestrator_runs',
      'thread_dependencies',
      'user_profiles',
      'instance_settings',
      'invite_links',
    ];
    for (const table of tables) {
      try {
        (db as any).run(sql.raw(`DELETE FROM ${table}`));
      } catch {
        // Table may not exist — skip
      }
    }
  };

  const testHeaders = (userId: string, role: 'user' | 'admin', extras?: { orgId?: string }) => ({
    'X-Test-User-Id': userId,
    'X-Test-User-Role': role,
    ...(extras?.orgId ? { 'X-Test-Org-Id': extras.orgId } : {}),
  });

  const requestAs = (
    userId: string,
    role: 'user' | 'admin' = 'user',
    extras?: { orgId?: string },
  ) => ({
    get: (path: string) =>
      Promise.resolve(
        app.request(path, {
          headers: testHeaders(userId, role, extras),
        }),
      ),
    post: (path: string, body?: any) =>
      Promise.resolve(
        app.request(path, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...testHeaders(userId, role, extras),
          },
          body: body ? JSON.stringify(body) : undefined,
        }),
      ),
    patch: (path: string, body?: any) =>
      Promise.resolve(
        app.request(path, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            ...testHeaders(userId, role, extras),
          },
          body: body ? JSON.stringify(body) : undefined,
        }),
      ),
    put: (path: string, body?: any) =>
      Promise.resolve(
        app.request(path, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            ...testHeaders(userId, role, extras),
          },
          body: body ? JSON.stringify(body) : undefined,
        }),
      ),
    delete: (path: string) =>
      Promise.resolve(
        app.request(path, {
          method: 'DELETE',
          headers: testHeaders(userId, role, extras),
        }),
      ),
  });

  const runnerHeaders = (runnerId: string) => ({
    'X-Test-Is-Runner': 'true',
    'X-Test-Runner-Id': runnerId,
  });

  const requestAsRunner = (runnerId: string) => ({
    get: (path: string) =>
      Promise.resolve(
        app.request(path, {
          headers: runnerHeaders(runnerId),
        }),
      ),
    post: (path: string, body?: any) =>
      Promise.resolve(
        app.request(path, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...runnerHeaders(runnerId),
          },
          body: body ? JSON.stringify(body) : undefined,
        }),
      ),
  });

  return { app, db, schema, requestAs, requestAsRunner, cleanup };
}
