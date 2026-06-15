/**
 * Re-exports SQLite schema from shared package.
 * All table definitions live in @funny/shared/db/schema-sqlite.
 *
 * Existing imports like `from '../db/schema.js'` continue to work unchanged.
 */
export {
  // Runtime tables
  projects,
  designs,
  threads,
  messages,
  startupCommands,
  toolCalls,
  automations,
  automationRuns,
  userProfiles,
  stageHistory,
  threadComments,
  threadShares,
  messageQueue,
  mcpOauthTokens,
  pipelines,
  pipelineRuns,
  orchestratorRuns,
  threadDependencies,
  watchers,
  jobs,
  teamProjects,
  threadEvents,
  instanceSettings,
  permissionRules,
  // Server-only tables
  runners,
  runnerProjectAssignments,
  runnerTasks,
  runnerEnrollments,
  projectMembers,
  projectMemberConfig,
  resourceGrants,
  inviteLinks,
  agentTemplates,
  // Better Auth identity tables. `user`/`member` are read directly by the
  // share routes (org-membership validation + invited-user display). The full
  // set is re-exported so this module satisfies `DatabaseConnection.schema`
  // (typeof sqliteSchema) — partial re-export left a long-standing type error
  // at the setConnection call sites.
  user,
  session,
  account,
  verification,
  member,
  organization,
  invitation,
} from '@funny/shared/db/schema-sqlite';
