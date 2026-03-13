/**
 * Central server DB schema (PostgreSQL).
 *
 * Tables managed here:
 * - projects: Team projects (source of truth in multi mode)
 * - project_members: User ↔ project assignments with roles
 * - runners: Registered runner machines
 * - runner_project_assignments: Which runner handles which project
 * - runner_tasks: Pending/completed tasks dispatched to runners
 * - threads: Lightweight thread mirror for routing + listing
 * - user_profiles: Git identity + GitHub token per user
 * - instance_settings: Key-value settings for the central instance
 *
 * Better Auth tables (user, session, account, organization, member, invitation)
 * are auto-created by Better Auth migrations — not defined here.
 */

import { pgTable, text, primaryKey } from 'drizzle-orm/pg-core';

// ── Projects (source of truth for team projects) ─────────

export const projects = pgTable('projects', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  repoUrl: text('repo_url').notNull(),
  description: text('description'),
  createdBy: text('created_by').notNull(),
  organizationId: text('organization_id'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

// ── Project Members ──────────────────────────────────────

export const projectMembers = pgTable(
  'project_members',
  {
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
    role: text('role').notNull().default('member'), // 'admin' | 'member'
    localPath: text('local_path'), // path on the user's runner machine
    joinedAt: text('joined_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.userId] })],
);

// ── Runners ──────────────────────────────────────────────

export const runners = pgTable('runners', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  hostname: text('hostname').notNull(),
  userId: text('user_id'), // which user owns this runner (null = unassigned)
  token: text('token').notNull().unique(),
  status: text('status').notNull().default('offline'), // online | busy | offline
  os: text('os').notNull().default('unknown'),
  workspace: text('workspace'),
  httpUrl: text('http_url'), // runner's HTTP base URL for proxying
  activeThreadIds: text('active_thread_ids').notNull().default('[]'),
  registeredAt: text('registered_at').notNull(),
  lastHeartbeatAt: text('last_heartbeat_at').notNull(),
});

// ── Runner ↔ Project Assignments ─────────────────────────

export const runnerProjectAssignments = pgTable(
  'runner_project_assignments',
  {
    runnerId: text('runner_id')
      .notNull()
      .references(() => runners.id, { onDelete: 'cascade' }),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    localPath: text('local_path').notNull(),
    assignedAt: text('assigned_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.runnerId, t.projectId] })],
);

// ── Runner Tasks ─────────────────────────────────────────

export const runnerTasks = pgTable('runner_tasks', {
  id: text('id').primaryKey(),
  runnerId: text('runner_id')
    .notNull()
    .references(() => runners.id, { onDelete: 'cascade' }),
  type: text('type').notNull(),
  threadId: text('thread_id').notNull(),
  payload: text('payload').notNull(),
  status: text('status').notNull().default('pending'),
  resultData: text('result_data'),
  resultError: text('result_error'),
  createdAt: text('created_at').notNull(),
  completedAt: text('completed_at'),
});

// ── Threads (lightweight mirror for routing + listing) ───

export const threads = pgTable('threads', {
  id: text('id').primaryKey(),
  projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }),
  runnerId: text('runner_id').references(() => runners.id, { onDelete: 'set null' }),
  userId: text('user_id').notNull(),
  title: text('title'),
  status: text('status').notNull().default('idle'),
  stage: text('stage').notNull().default('backlog'),
  model: text('model'),
  mode: text('mode'),
  branch: text('branch'),
  createdAt: text('created_at').notNull(),
  completedAt: text('completed_at'),
});

// ── User Profiles ────────────────────────────────────────

export const userProfiles = pgTable('user_profiles', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().unique(),
  gitName: text('git_name'),
  gitEmail: text('git_email'),
  githubToken: text('github_token'), // encrypted
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

// ── Instance Settings ────────────────────────────────────

export const instanceSettings = pgTable('instance_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: text('updated_at').notNull(),
});

// ── Invite Links ─────────────────────────────────────────

export const inviteLinks = pgTable('invite_links', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id').notNull(),
  token: text('token').notNull().unique(),
  role: text('role').notNull().default('member'),
  createdBy: text('created_by').notNull(),
  expiresAt: text('expires_at'),
  maxUses: text('max_uses'), // stored as text, parsed as number
  useCount: text('use_count').notNull().default('0'), // stored as text, parsed as number
  revoked: text('revoked').notNull().default('0'), // '0' or '1'
  createdAt: text('created_at').notNull(),
});
