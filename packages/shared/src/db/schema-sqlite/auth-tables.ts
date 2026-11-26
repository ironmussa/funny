// Re-exported from `../schema.sqlite.js`.
import { sqliteTable, text, integer, uniqueIndex } from 'drizzle-orm/sqlite-core';

import { dateText } from './columns.js';
import { projects } from './runtime-tables.js';

// ── Better Auth tables ──────────────────────────────────────────
// These must be passed explicitly to drizzleAdapter since they live
// outside the runtime schema. Column names match migration 026.

export const user = sqliteTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  // Better Auth expects real booleans (its cookie-cache payload is Zod-validated),
  // so read the 0/1 integer columns back as booleans.
  emailVerified: integer('email_verified', { mode: 'boolean' }).notNull().default(false),
  image: text('image'),
  createdAt: dateText('created_at').notNull(),
  updatedAt: dateText('updated_at').notNull(),
  username: text('username').unique(),
  displayUsername: text('display_username'),
  role: text('role'),
  banned: integer('banned', { mode: 'boolean' }),
  banReason: text('ban_reason'),
  banExpires: dateText('ban_expires'),
});

// Better Auth requires matching fields in both dialect-specific schemas.
// fallow-ignore-next-line code-duplication
export const session = sqliteTable('session', {
  id: text('id').primaryKey(),
  expiresAt: dateText('expires_at').notNull(),
  token: text('token').notNull().unique(),
  createdAt: dateText('created_at').notNull(),
  updatedAt: dateText('updated_at').notNull(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  impersonatedBy: text('impersonated_by'),
  activeOrganizationId: text('active_organization_id'),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
});

export const account = sqliteTable('account', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  idToken: text('id_token'),
  accessTokenExpiresAt: dateText('access_token_expires_at'),
  refreshTokenExpiresAt: dateText('refresh_token_expires_at'),
  scope: text('scope'),
  password: text('password'),
  createdAt: dateText('created_at').notNull(),
  updatedAt: dateText('updated_at').notNull(),
});

export const verification = sqliteTable('verification', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: dateText('expires_at').notNull(),
  createdAt: dateText('created_at'),
  updatedAt: dateText('updated_at'),
});

export const organization = sqliteTable('organization', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  slug: text('slug').unique(),
  logo: text('logo'),
  createdAt: dateText('created_at').notNull(),
  metadata: text('metadata'),
});

export const member = sqliteTable('member', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id')
    .notNull()
    .references(() => organization.id, { onDelete: 'cascade' }),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  role: text('role').notNull(),
  createdAt: dateText('created_at').notNull(),
});

// ── Agent Templates (global, per-user) ──────────────────
export const agentTemplates = sqliteTable('agent_templates', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  name: text('name').notNull(),
  description: text('description'),
  icon: text('icon'),
  color: text('color'),
  model: text('model'),
  systemPromptMode: text('system_prompt_mode').notNull().default('prepend'),
  systemPrompt: text('system_prompt'),
  disallowedTools: text('disallowed_tools'), // JSON array
  mcpServers: text('mcp_servers'), // JSON array
  builtinSkillsDisabled: text('builtin_skills_disabled'), // JSON array
  customSkillPaths: text('custom_skill_paths'), // JSON array
  agentName: text('agent_name'),
  shared: integer('shared', { mode: 'boolean' }).notNull().default(false), // visible to all users
  variables: text('variables'), // JSON array of template variables
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

// Better Auth requires matching fields in both dialect-specific schemas.
// fallow-ignore-next-line code-duplication
export const invitation = sqliteTable('invitation', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id')
    .notNull()
    .references(() => organization.id, { onDelete: 'cascade' }),
  email: text('email').notNull(),
  role: text('role'),
  status: text('status').notNull(),
  createdAt: dateText('created_at').notNull(),
  expiresAt: dateText('expires_at').notNull(),
  inviterId: text('inviter_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
});

/** Browser push subscriptions, isolated by authenticated user. */
export const pushSubscriptions = sqliteTable('push_subscriptions', {
  endpoint: text('endpoint').primaryKey(),
  userId: text('user_id').notNull(),
  p256dh: text('p256dh').notNull(),
  auth: text('auth').notNull(),
});

/**
 * Project secrets (openspec `project-secrets`): named values handed to the
 * project's agents as environment variables. `scope = 'project'` rows are
 * shared by the members and carry `user_id = ''` (not NULL: a unique index
 * treats NULLs as distinct, which would allow duplicate shared names);
 * `scope = 'user'` rows belong to one member. `ciphertext` is keyring-encrypted.
 */
export const projectSecrets = sqliteTable(
  'project_secrets',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    scope: text('scope').notNull(),
    userId: text('user_id').notNull().default(''),
    name: text('name').notNull(),
    ciphertext: text('ciphertext').notNull(),
    allowInSandbox: integer('allow_in_sandbox').notNull().default(0),
    updatedBy: text('updated_by').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [uniqueIndex('project_secrets_scope_name').on(t.projectId, t.scope, t.userId, t.name)],
);
