/**
 * @domain subdomain: Shared Kernel
 * @domain type: value-object
 * @domain layer: domain
 */

import { validationErr, type DomainError } from '@funny/shared/errors';
import { DEFAULT_MODEL, DEFAULT_PROVIDER, DEFAULT_PERMISSION_MODE } from '@funny/shared/models';
import { ok, err, type Result } from 'neverthrow';
import { z } from 'zod';

// ── Enums ────────────────────────────────────────────────────────

export const threadModeSchema = z.enum(['local', 'worktree']);
export const threadRuntimeSchema = z.enum(['local', 'remote']);
export const agentProviderSchema = z.enum(['claude', 'codex', 'gemini', 'deepagent', 'openswe']);
export const claudeModelSchema = z.enum(['sonnet', 'sonnet-4.6', 'opus', 'opus-4.7', 'haiku']);
export const codexModelSchema = z.enum(['o3', 'o4-mini', 'codex-mini']);
export const geminiModelSchema = z.enum([
  'gemini-2.0-flash',
  'gemini-2.5-flash',
  'gemini-2.5-pro',
  'gemini-3-flash-preview',
  'gemini-3-pro-preview',
]);
export const deepagentModelSchema = z.enum([
  'minimax-m2.7',
  'minimax-m2.7-highspeed',
  'deepagent-gpt-4o',
  'deepagent-sonnet',
  'deepagent-gemini-2.5-flash',
  'deepagent-gemini-2.5-pro',
  'deepagent-gemini-3-flash',
  'deepagent-gemini-3-pro',
  'deepagent-grok-3',
  'deepagent-grok-3-mini',
  'deepagent-glm-5.1',
  'deepagent-glm-5-turbo',
  'deepagent-glm-5v-turbo',
]);
export const opensweModelSchema = z.enum(['openswe-default']);
export const agentModelSchema = z.union([
  claudeModelSchema,
  codexModelSchema,
  geminiModelSchema,
  deepagentModelSchema,
  opensweModelSchema,
]);
export const permissionModeSchema = z.enum(['plan', 'auto', 'autoEdit', 'confirmEdit', 'ask']);
export const threadStageSchema = z.enum(['backlog', 'planning', 'in_progress', 'review', 'done']);
export const threadSourceSchema = z.enum([
  'web',
  'chrome_extension',
  'api',
  'automation',
  'ingest',
]);

// ── Image attachment ─────────────────────────────────────────────

const imageAttachmentSchema = z.object({
  type: z.literal('image'),
  source: z.object({
    type: z.literal('base64'),
    media_type: z.enum(['image/jpeg', 'image/png', 'image/gif', 'image/webp']),
    data: z.string().max(10_000_000), // ~7.5MB binary after base64 decode
  }),
});

// ── File references ──────────────────────────────────────────────

const fileReferenceSchema = z.object({
  path: z.string().min(1),
});

const symbolReferenceSchema = z.object({
  path: z.string().min(1),
  name: z.string().min(1),
  kind: z.string().min(1),
  line: z.number().int().min(1),
  endLine: z.number().int().min(1).optional(),
});

// ── Request body schemas ─────────────────────────────────────────

export const createProjectSchema = z.object({
  name: z.string().min(1, 'name is required'),
  path: z.string().min(1, 'path is required'),
});

export const renameProjectSchema = z.object({
  name: z.string().min(1, 'name is required'),
});

export const followUpModeSchema = z.enum(['interrupt', 'queue', 'ask']);

export const updateProjectSchema = z.object({
  name: z.string().min(1, 'name is required').optional(),
  color: z
    .string()
    .regex(/^#[0-9A-Fa-f]{6}$/, 'color must be a valid hex color (#RRGGBB)')
    .nullable()
    .optional(),
  followUpMode: followUpModeSchema.optional(),
  defaultProvider: agentProviderSchema.nullable().optional(),
  defaultModel: agentModelSchema.nullable().optional(),
  defaultMode: threadModeSchema.nullable().optional(),
  defaultPermissionMode: permissionModeSchema.nullable().optional(),
  defaultBranch: z.string().nullable().optional(),
  urls: z.array(z.string().url()).nullable().optional(),
  systemPrompt: z.string().max(50000).nullable().optional(),
  launcherUrl: z.string().url().nullable().optional(),
});

export const reorderProjectsSchema = z.object({
  projectIds: z.array(z.string().min(1)).min(1, 'projectIds must not be empty'),
});

export const threadPurposeSchema = z.enum(['explore', 'plan', 'implement']);
export const effortLevelSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);

export const createThreadSchema = z.object({
  projectId: z.string().min(1),
  title: z.string().max(500).optional().default(''),
  mode: threadModeSchema,
  runtime: threadRuntimeSchema.optional().default('local'),
  provider: agentProviderSchema.optional().default(DEFAULT_PROVIDER),
  model: agentModelSchema.optional().default(DEFAULT_MODEL),
  permissionMode: permissionModeSchema.optional().default(DEFAULT_PERMISSION_MODE),
  effort: effortLevelSchema.optional(),
  source: threadSourceSchema.optional().default('web'),
  baseBranch: z.string().optional(),
  prompt: z.string().min(1, 'prompt is required').max(500_000),
  images: z.array(imageAttachmentSchema).max(10).optional(),
  allowedTools: z.array(z.string()).optional(),
  disallowedTools: z.array(z.string()).optional(),
  fileReferences: z.array(fileReferenceSchema).max(20).optional(),
  symbolReferences: z.array(symbolReferenceSchema).max(20).optional(),
  worktreePath: z.string().optional(),
  parentThreadId: z.string().optional(),
  arcId: z.string().optional(),
  purpose: threadPurposeSchema.optional().default('implement'),
  agentTemplateId: z.string().optional(),
  templateVariables: z.record(z.string(), z.string()).optional(),
});

export const createIdleThreadSchema = z.object({
  projectId: z.string().min(1),
  title: z.string().min(1, 'title is required'),
  mode: threadModeSchema,
  source: threadSourceSchema.optional().default('web'),
  baseBranch: z.string().optional(),
  prompt: z.string().optional(),
  images: z.array(imageAttachmentSchema).optional(),
  stage: z.enum(['backlog', 'planning']).optional().default('backlog'),
  arcId: z.string().optional(),
  purpose: threadPurposeSchema.optional().default('implement'),
});

export const sendMessageSchema = z.object({
  content: z.string().min(1, 'content is required').max(500_000),
  provider: agentProviderSchema.optional(),
  model: agentModelSchema.optional(),
  permissionMode: permissionModeSchema.optional(),
  effort: effortLevelSchema.optional(),
  images: z.array(imageAttachmentSchema).optional(),
  allowedTools: z.array(z.string()).optional(),
  disallowedTools: z.array(z.string()).optional(),
  fileReferences: z.array(fileReferenceSchema).max(20).optional(),
  symbolReferences: z.array(symbolReferenceSchema).max(20).optional(),
  baseBranch: z.string().optional(),
  forceQueue: z.boolean().optional(),
});

export const updateQueuedMessageSchema = z.object({
  content: z.string().min(1, 'content is required'),
});

export const updateThreadSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  archived: z.boolean().optional(),
  pinned: z.boolean().optional(),
  stage: threadStageSchema.optional(),
});

export const stageFilesSchema = z.object({
  paths: z.array(z.string()).min(1, 'paths must not be empty'),
});

export const stagePatchSchema = z.object({
  patch: z.string().min(1, 'patch must not be empty').max(5_000_000),
});

export const resolveConflictSchema = z.object({
  filePath: z.string().min(1, 'filePath is required'),
  blockIndex: z.number().int().min(0, 'blockIndex must be non-negative'),
  resolution: z.enum(['ours', 'theirs', 'both']),
});

export const commitSchema = z.object({
  message: z.string().min(1, 'message is required').max(50_000),
  amend: z.boolean().optional().default(false),
  noVerify: z.boolean().optional().default(false),
});

export const createPRSchema = z.object({
  title: z.string().min(1, 'title is required').max(500),
  body: z.string().max(100_000),
});

export const pullStrategySchema = z.enum(['ff-only', 'merge', 'rebase']);
export const pullSchema = z.object({
  strategy: pullStrategySchema.optional().default('ff-only'),
});

export const createCommandSchema = z.object({
  label: z.string().min(1, 'label is required').max(200),
  command: z.string().min(1, 'command is required').max(10_000),
  port: z.number().int().optional(),
  portEnvVar: z.string().optional(),
});

export const hookTypeSchema = z.enum([
  'pre-commit',
  'commit-msg',
  'pre-push',
  'post-commit',
  'post-merge',
  'post-checkout',
]);

export const createHookSchema = z.object({
  hookType: hookTypeSchema.optional().default('pre-commit'),
  label: z.string().min(1, 'label is required'),
  command: z.string().min(1, 'command is required'),
});

export const updateHookSchema = z.object({
  hookType: hookTypeSchema.optional(),
  label: z.string().min(1).optional(),
  command: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
});

export const reorderHooksSchema = z.object({
  hookType: hookTypeSchema,
  newOrder: z.array(z.number().int().min(0)),
});

export const createWorktreeSchema = z.object({
  projectId: z.string().min(1),
  branchName: z.string().min(1),
  baseBranch: z.string().min(1, 'baseBranch is required'),
});

export const deleteWorktreeSchema = z.object({
  projectId: z.string().min(1),
  worktreePath: z.string().min(1),
  branchName: z.string().optional(),
  deleteBranch: z.boolean().optional().default(false),
});

export const addSkillSchema = z.object({
  identifier: z.string().min(1, 'identifier is required'),
});

export const addMcpServerSchema = z.object({
  name: z.string().min(1),
  type: z.enum(['stdio', 'http', 'sse']),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  url: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  scope: z.enum(['project', 'user']).optional(),
  projectPath: z.string().min(1),
});

export const mergeSchema = z.object({
  targetBranch: z.string().optional(),
  push: z.boolean().optional().default(false),
  cleanup: z.boolean().optional().default(false),
});

const gitWorkflowActionSchema = z.enum([
  'commit',
  'amend',
  'commit-push',
  'commit-pr',
  'commit-merge',
  'push',
  'merge',
  'create-pr',
]);

export const workflowSchema = z.object({
  action: gitWorkflowActionSchema,
  message: z.string().max(50_000).optional(),
  filesToStage: z.array(z.string().max(1000)).max(1000).optional().default([]),
  filesToUnstage: z.array(z.string().max(1000)).max(1000).optional().default([]),
  amend: z.boolean().optional().default(false),
  noVerify: z.boolean().optional().default(false),
  prTitle: z.string().max(500).optional(),
  prBody: z.string().max(100_000).optional(),
  targetBranch: z.string().optional(),
  cleanup: z.boolean().optional().default(true),
});

export const gitInitSchema = z.object({
  path: z.string().min(1, 'path is required'),
});

export const publishRepoSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-zA-Z0-9_.-]+$/, 'Invalid repository name'),
  description: z.string().max(350).optional(),
  org: z.string().optional(),
  private: z.boolean().default(true),
});

export const setRemoteSchema = z.object({
  url: z
    .string()
    .min(1, 'url is required')
    .max(2048)
    .regex(
      /^(https?:\/\/|git:\/\/|ssh:\/\/|git@[^\s:]+:)/,
      'URL must start with https://, ssh://, git:// or use the git@host:path form',
    ),
});

// ── Automations ─────────────────────────────────────────────────

export const automationScheduleSchema = z
  .string()
  .min(1, 'schedule is required')
  .refine(
    (val) => {
      try {
        // Validate cron expression using croner
        const { Cron } = require('croner');
        new Cron(val); // throws if invalid
        return true;
      } catch {
        return false;
      }
    },
    {
      message:
        'Invalid cron expression. Examples: "*/30 * * * *" (every 30 min), "0 9 * * *" (daily at 9am), "0 */6 * * *" (every 6 hours)',
    },
  );

export const automationModeSchema = z.enum(['default']);

export const createAutomationSchema = z.object({
  projectId: z.string().min(1),
  name: z.string().min(1, 'name is required').max(200),
  prompt: z.string().min(1, 'prompt is required').max(500_000),
  schedule: automationScheduleSchema,
  provider: agentProviderSchema.optional().default(DEFAULT_PROVIDER),
  model: agentModelSchema.optional().default(DEFAULT_MODEL),
  permissionMode: permissionModeSchema.optional().default(DEFAULT_PERMISSION_MODE),
  mode: automationModeSchema.optional().default('default'),
});

export const updateAutomationSchema = z.object({
  name: z.string().min(1).optional(),
  prompt: z.string().min(1).optional(),
  schedule: automationScheduleSchema.optional(),
  provider: agentProviderSchema.optional(),
  model: agentModelSchema.optional(),
  permissionMode: permissionModeSchema.optional(),
  enabled: z.boolean().optional(),
  maxRunHistory: z.number().int().min(1).max(100).optional(),
  mode: automationModeSchema.optional(),
});

export const updateRunTriageSchema = z.object({
  triageStatus: z.enum(['pending', 'reviewed', 'dismissed']),
});

// ── GitHub ──────────────────────────────────────────────────────

/** Allowed git hosting domains for clone operations. */
const ALLOWED_CLONE_HOSTS = new Set([
  'github.com',
  'gitlab.com',
  'bitbucket.org',
  'dev.azure.com',
  'ssh.dev.azure.com',
]);

export const cloneRepoSchema = z.object({
  cloneUrl: z
    .string()
    .url('Valid clone URL required')
    .refine(
      (url) => {
        try {
          const host = new URL(url).hostname;
          return ALLOWED_CLONE_HOSTS.has(host);
        } catch {
          return false;
        }
      },
      {
        message:
          'Clone URL must be from a supported git hosting provider (GitHub, GitLab, Bitbucket, Azure DevOps)',
      },
    ),
  destinationPath: z.string().min(1, 'Destination path is required'),
  name: z.string().optional(),
});

export const githubPollSchema = z.object({
  deviceCode: z.string().min(1, 'device_code is required'),
});

export const approveToolSchema = z.object({
  toolName: z.string().min(1, 'toolName is required'),
  approved: z.boolean(),
  allowedTools: z.array(z.string()).optional(),
  disallowedTools: z.array(z.string()).optional(),
});

// ── Helper ───────────────────────────────────────────────────────

/** Validate request body; returns Result<T, DomainError> */
export function validate<T>(schema: z.ZodType<T>, data: unknown): Result<T, DomainError> {
  const result = schema.safeParse(data);
  if (!result.success) {
    const firstIssue = result.error.issues[0];
    return err(validationErr(firstIssue?.message ?? 'Invalid request body'));
  }
  return ok(result.data);
}
