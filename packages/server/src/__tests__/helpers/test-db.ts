/**
 * In-memory SQLite database for testing.
 * Creates a fresh DB with the same schema for each test suite.
 */
import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import * as schema from '../../db/schema.js';
import { sql } from 'drizzle-orm';

export function createTestDb() {
  const sqlite = new Database(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');

  const testDb = drizzle(sqlite, { schema });

  // Create tables
  testDb.run(sql`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);

  testDb.run(sql`
    CREATE TABLE IF NOT EXISTS threads (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      mode TEXT NOT NULL,
      model TEXT NOT NULL DEFAULT 'sonnet',
      permission_mode TEXT NOT NULL DEFAULT 'autoEdit',
      status TEXT NOT NULL DEFAULT 'pending',
      branch TEXT,
      worktree_path TEXT,
      session_id TEXT,
      cost REAL NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      completed_at TEXT
    )
  `);

  testDb.run(sql`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      images TEXT,
      timestamp TEXT NOT NULL
    )
  `);

  testDb.run(sql`
    CREATE TABLE IF NOT EXISTS tool_calls (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      input TEXT,
      output TEXT
    )
  `);

  return { db: testDb, sqlite, schema };
}

/** Insert a test project and return it */
export function seedProject(db: ReturnType<typeof createTestDb>['db'], overrides: Partial<typeof schema.projects.$inferInsert> = {}) {
  const project = {
    id: overrides.id ?? 'test-project-1',
    name: overrides.name ?? 'Test Project',
    path: overrides.path ?? '/tmp/test-repo',
    createdAt: overrides.createdAt ?? new Date().toISOString(),
  };
  db.insert(schema.projects).values(project).run();
  return project;
}

/** Insert a test thread and return it */
export function seedThread(db: ReturnType<typeof createTestDb>['db'], overrides: Partial<typeof schema.threads.$inferInsert> = {}) {
  const thread = {
    id: overrides.id ?? 'test-thread-1',
    projectId: overrides.projectId ?? 'test-project-1',
    title: overrides.title ?? 'Test Thread',
    mode: overrides.mode ?? 'local',
    permissionMode: overrides.permissionMode ?? 'autoEdit',
    status: overrides.status ?? 'pending',
    branch: overrides.branch ?? null,
    worktreePath: overrides.worktreePath ?? null,
    sessionId: overrides.sessionId ?? null,
    cost: overrides.cost ?? 0,
    archived: overrides.archived ?? 0,
    createdAt: overrides.createdAt ?? new Date().toISOString(),
    completedAt: overrides.completedAt ?? null,
  };
  db.insert(schema.threads).values(thread).run();
  return thread;
}

/** Insert a test message and return it */
export function seedMessage(db: ReturnType<typeof createTestDb>['db'], overrides: Partial<typeof schema.messages.$inferInsert> = {}) {
  const message = {
    id: overrides.id ?? 'test-msg-1',
    threadId: overrides.threadId ?? 'test-thread-1',
    role: overrides.role ?? 'user',
    content: overrides.content ?? 'Hello world',
    timestamp: overrides.timestamp ?? new Date().toISOString(),
  };
  db.insert(schema.messages).values(message).run();
  return message;
}

/** Insert a test tool call and return it */
export function seedToolCall(db: ReturnType<typeof createTestDb>['db'], overrides: Partial<typeof schema.toolCalls.$inferInsert> = {}) {
  const toolCall = {
    id: overrides.id ?? 'test-tc-1',
    messageId: overrides.messageId ?? 'test-msg-1',
    name: overrides.name ?? 'Read',
    input: overrides.input ?? '{"file": "test.ts"}',
    output: overrides.output ?? null,
  };
  db.insert(schema.toolCalls).values(toolCall).run();
  return toolCall;
}
