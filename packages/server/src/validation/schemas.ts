import { z } from 'zod';
import { ok, err, type Result } from 'neverthrow';
import { validationErr, type DomainError } from '@a-parallel/shared/errors';

// ── Enums ────────────────────────────────────────────────────────

export const threadModeSchema = z.enum(['local', 'worktree']);
export const claudeModelSchema = z.enum(['sonnet', 'opus', 'haiku']);
export const permissionModeSchema = z.enum(['plan', 'autoEdit', 'confirmEdit']);

// ── Image attachment ─────────────────────────────────────────────

const imageAttachmentSchema = z.object({
  type: z.literal('image'),
  source: z.object({
    type: z.literal('base64'),
    media_type: z.enum(['image/jpeg', 'image/png', 'image/gif', 'image/webp']),
    data: z.string(),
  }),
});

// ── Request body schemas ─────────────────────────────────────────

export const createProjectSchema = z.object({
  name: z.string().min(1, 'name is required'),
  path: z.string().min(1, 'path is required'),
});

export const renameProjectSchema = z.object({
  name: z.string().min(1, 'name is required'),
});

export const reorderProjectsSchema = z.object({
  projectIds: z.array(z.string().min(1)).min(1, 'projectIds must not be empty'),
});

export const createThreadSchema = z.object({
  projectId: z.string().min(1),
  title: z.string().optional().default(''),
  mode: threadModeSchema,
  model: claudeModelSchema.optional().default('sonnet'),
  permissionMode: permissionModeSchema.optional().default('autoEdit'),
  baseBranch: z.string().optional(),
  prompt: z.string().min(1, 'prompt is required'),
  images: z.array(imageAttachmentSchema).optional(),
});

export const sendMessageSchema = z.object({
  content: z.string().min(1, 'content is required'),
  model: claudeModelSchema.optional(),
  permissionMode: permissionModeSchema.optional(),
  images: z.array(imageAttachmentSchema).optional(),
});

export const updateThreadSchema = z.object({
  archived: z.boolean().optional(),
  pinned: z.boolean().optional(),
});

export const stageFilesSchema = z.object({
  paths: z.array(z.string()).min(1, 'paths must not be empty'),
});

export const commitSchema = z.object({
  message: z.string().min(1, 'message is required'),
});

export const createPRSchema = z.object({
  title: z.string().min(1, 'title is required'),
  body: z.string(),
});

export const createCommandSchema = z.object({
  label: z.string().min(1, 'label is required'),
  command: z.string().min(1, 'command is required'),
  port: z.number().nullable().optional(),
  portEnvVar: z.string().nullable().optional(),
});

export const createWorktreeSchema = z.object({
  projectId: z.string().min(1),
  branchName: z.string().min(1),
  baseBranch: z.string().min(1, 'baseBranch is required'),
});

export const deleteWorktreeSchema = z.object({
  projectId: z.string().min(1),
  worktreePath: z.string().min(1),
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
  headers: z.record(z.string()).optional(),
  env: z.record(z.string()).optional(),
  scope: z.enum(['project', 'user']).optional(),
  projectPath: z.string().min(1),
});

export const mergeSchema = z.object({
  targetBranch: z.string().optional(),
  push: z.boolean().optional().default(false),
  cleanup: z.boolean().optional().default(false),
});

export const gitInitSchema = z.object({
  path: z.string().min(1, 'path is required'),
});

// ── Automations ─────────────────────────────────────────────────

export const automationScheduleSchema = z.string().min(1, 'schedule is required').refine(
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
  { message: 'Invalid cron expression. Examples: "*/30 * * * *" (every 30 min), "0 9 * * *" (daily at 9am), "0 */6 * * *" (every 6 hours)' }
);

export const createAutomationSchema = z.object({
  projectId: z.string().min(1),
  name: z.string().min(1, 'name is required'),
  prompt: z.string().min(1, 'prompt is required'),
  schedule: automationScheduleSchema,
  model: claudeModelSchema.optional().default('sonnet'),
  permissionMode: permissionModeSchema.optional().default('autoEdit'),
});

export const updateAutomationSchema = z.object({
  name: z.string().min(1).optional(),
  prompt: z.string().min(1).optional(),
  schedule: automationScheduleSchema.optional(),
  model: claudeModelSchema.optional(),
  permissionMode: permissionModeSchema.optional(),
  enabled: z.boolean().optional(),
  maxRunHistory: z.number().int().min(1).max(100).optional(),
});

export const updateRunTriageSchema = z.object({
  triageStatus: z.enum(['pending', 'reviewed', 'dismissed']),
});

// ── GitHub ──────────────────────────────────────────────────────

export const cloneRepoSchema = z.object({
  cloneUrl: z.string().url('Valid clone URL required'),
  destinationPath: z.string().min(1, 'Destination path is required'),
  name: z.string().optional(),
});

export const githubPollSchema = z.object({
  deviceCode: z.string().min(1, 'device_code is required'),
});

export const approveToolSchema = z.object({
  toolName: z.string().min(1, 'toolName is required'),
  approved: z.boolean(),
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
