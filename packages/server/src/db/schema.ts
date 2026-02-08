import { sqliteTable, text, real, integer } from 'drizzle-orm/sqlite-core';

export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  path: text('path').notNull(),
  createdAt: text('created_at').notNull(),
});

export const threads = sqliteTable('threads', {
  id: text('id').primaryKey(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  mode: text('mode').notNull(), // 'local' | 'worktree'
  permissionMode: text('permission_mode').notNull().default('autoEdit'), // 'plan' | 'autoEdit' | 'confirmEdit'
  status: text('status').notNull().default('pending'), // 'pending' | 'running' | 'completed' | 'failed' | 'stopped'
  branch: text('branch'),
  worktreePath: text('worktree_path'),
  sessionId: text('session_id'),
  cost: real('cost').notNull().default(0),
  archived: integer('archived').notNull().default(0),
  createdAt: text('created_at').notNull(),
  completedAt: text('completed_at'),
});

export const messages = sqliteTable('messages', {
  id: text('id').primaryKey(),
  threadId: text('thread_id')
    .notNull()
    .references(() => threads.id, { onDelete: 'cascade' }),
  role: text('role').notNull(), // 'user' | 'assistant' | 'system'
  content: text('content').notNull(),
  images: text('images'), // JSON-encoded ImageAttachment[]
  timestamp: text('timestamp').notNull(),
});

export const startupCommands = sqliteTable('startup_commands', {
  id: text('id').primaryKey(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  label: text('label').notNull(),
  command: text('command').notNull(),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: text('created_at').notNull(),
});

export const toolCalls = sqliteTable('tool_calls', {
  id: text('id').primaryKey(),
  messageId: text('message_id')
    .notNull()
    .references(() => messages.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  input: text('input'),
  output: text('output'),
});
