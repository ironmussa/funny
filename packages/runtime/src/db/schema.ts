/**
 * Re-exports SQLite schema from shared package.
 * All table definitions now live in @funny/shared/db/schema-sqlite.
 *
 * Existing imports like `from '../db/schema.js'` continue to work unchanged.
 */
export {
  projects,
  threads,
  threadSessions,
  messages,
  startupCommands,
  toolCalls,
  automations,
  automationRuns,
  userProfiles,
  stageHistory,
  threadComments,
  messageQueue,
  mcpOauthTokens,
  pipelines,
  pipelineRuns,
  teamProjects,
  threadEvents,
  instanceSettings,
  // Server-only tables (available but unused in runtime-only mode)
  runners,
  runnerProjectAssignments,
  runnerTasks,
  projectMembers,
  inviteLinks,
} from '@funny/shared/db/schema-sqlite';
