/**
 * The kinds of background activity (track-background-activities, design D3).
 *
 * Each kind declares the schema of the input it records. The server parses an
 * activity's input with it when the activity starts; zod's default object
 * parsing drops undeclared fields, so a stray token never reaches the row. The
 * client reads the same schemas when it refills a form to retry.
 *
 * Browser-safe: zod only.
 *
 * Each kind also declares (track-funny-actions, design D5), statically:
 * - `destructive`: the panel marks its rows;
 * - `record`: `always`, or `on-failure` for routine actions whose successful
 *   runs leave no row (they are recorded only through `recordActivity`). A
 *   destructive kind always records.
 *
 * To add a kind: declare it here, wrap the operation with the runner's
 * `trackActivity` / `recordActivity` (or the server's `trackServerActivity` /
 * `recordServerActivity`), and add its retry target in the client's
 * `lib/activity-retry.ts` when the user has somewhere to redo it.
 */
import { z } from 'zod';

import type { Activity, ActivityEffect, ActivityEffectType, ActivityOrigin } from '../types.js';

/** Removes the user and password of a URL (`https://user:token@host/x` → `https://host/x`). */
export function stripUrlCredentials(url: string): string {
  try {
    const parsed = new URL(url);
    if (!parsed.username && !parsed.password) return url;
    parsed.username = '';
    parsed.password = '';
    return parsed.toString();
  } catch {
    // Not a URL git would read as one with credentials (scp-like `git@host:x`).
    return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/]*@/i, '$1');
  }
}

const cloneUrl = z
  .string()
  .max(2048)
  .transform((value) => stripUrlCredentials(value));

const branchName = z.string().max(512);

/** Why a workspace was cleaned up (design D2). */
export const WORKSPACE_CLEANUP_REASONS = [
  'thread-archived',
  'thread-deleted',
  'merged',
  'factory-merged',
  // A factory run that ended without a commit; removed only when nothing is lost.
  'factory-no-change',
  // A retried factory run: the old worktree held the run's branch; removed only when nothing is lost.
  'factory-retried',
  'review-finished',
  'manual',
  'setup-undone',
] as const;

export type WorkspaceCleanupReason = (typeof WORKSPACE_CLEANUP_REASONS)[number];

/** The most paths a `git.destructive` input keeps (the title says the total). */
export const GIT_DESTRUCTIVE_PATHS_MAX = 50;

export const ACTIVITY_KINDS = {
  'project.clone': {
    scope: 'none',
    destructive: false,
    record: 'always',
    input: z.object({
      cloneUrl,
      destinationPath: z.string().max(4096),
      name: z.string().max(256).optional(),
    }),
  },
  'worktree.setup': {
    scope: 'thread',
    destructive: false,
    record: 'always',
    input: z.object({
      branch: branchName.optional(),
      baseBranch: branchName.optional(),
    }),
  },
  'git.workflow': {
    scope: 'thread',
    destructive: false,
    record: 'always',
    input: z.object({
      action: z.enum([
        'commit',
        'amend',
        'commit-push',
        'commit-pr',
        'commit-merge',
        'push',
        'merge',
        'create-pr',
      ]),
    }),
  },
  'workspace.cleanup': {
    scope: 'project',
    destructive: true,
    record: 'always',
    input: z.object({
      reason: z.enum(WORKSPACE_CLEANUP_REASONS),
      branch: branchName.optional(),
      deleteBranch: z.boolean(),
    }),
  },
  'workspace.prune': {
    scope: 'project',
    destructive: true,
    record: 'always',
    input: z.object({}),
  },
  'checkout.switch': {
    scope: 'project',
    destructive: false,
    record: 'always',
    input: z.object({
      fromBranch: branchName.optional(),
      toBranch: branchName,
      stashed: z.boolean(),
      reason: z.enum(['thread-created', 'branch-checkout', 'merged']),
    }),
  },
  'sandbox.provision': {
    scope: 'thread',
    destructive: false,
    record: 'always',
    input: z.object({ connectionId: z.string().max(128) }),
  },
  'sandbox.stop': {
    scope: 'thread',
    destructive: false,
    record: 'on-failure',
    input: z.object({ reason: z.enum(['idle', 'requested']) }),
  },
  'sandbox.wake': {
    scope: 'thread',
    destructive: false,
    record: 'on-failure',
    input: z.object({}),
  },
  'sandbox.destroy': {
    scope: 'thread',
    destructive: true,
    record: 'always',
    input: z.object({
      reason: z.enum(['idle', 'thread-deleted', 'reconciled', 'released', 'requested']),
    }),
  },
  'factory.merge': {
    scope: 'project',
    destructive: true,
    record: 'always',
    input: z.object({
      issueNumber: z.number().int().optional(),
      prNumber: z.number().int(),
    }),
  },
  // A member closed the pull request of a run that a newer run of its issue replaced.
  'factory.close-pr': {
    scope: 'project',
    destructive: true,
    record: 'always',
    input: z.object({
      issueNumber: z.number().int().optional(),
      prNumber: z.number().int(),
      /** The pull request of the run that replaced it, when it has one. */
      replacedBy: z.number().int().optional(),
    }),
  },
  'factory.disabled': {
    scope: 'project',
    destructive: false,
    record: 'always',
    input: z.object({ reason: z.enum(['access-lost']) }),
  },
  // A member's controls over one of their factory's runs.
  'factory.stop': {
    scope: 'project',
    // Stopping a run stops its agents.
    destructive: true,
    record: 'always',
    input: z.object({ issueNumber: z.number().int().optional() }),
  },
  'factory.retry': {
    scope: 'project',
    destructive: false,
    record: 'always',
    input: z.object({ issueNumber: z.number().int().optional() }),
  },
  // A run that ended with no change, or was stopped, marked as done by a member.
  'factory.mark-done': {
    scope: 'project',
    // Only the run's state changes; nothing on GitHub or in a checkout.
    destructive: false,
    record: 'always',
    input: z.object({ issueNumber: z.number().int().optional() }),
  },
  // A parked too-large run split into its parts' issues by a member.
  'factory.split': {
    scope: 'project',
    // It opens issues on GitHub and takes the label off the parent.
    destructive: false,
    record: 'always',
    input: z.object({ issueNumber: z.number().int().optional() }),
  },
  'factory.approve-merge': {
    scope: 'project',
    // The merge it allows is recorded as its own `factory.merge`.
    destructive: false,
    record: 'always',
    input: z.object({
      issueNumber: z.number().int().optional(),
      sha: z.string().max(64).optional(),
    }),
  },
  // A member's merge approval moved to another commit of the pull request
  // (openspec factory-approval-survives-integration): recorded for the approver.
  'factory.approval-moved': {
    scope: 'project',
    // The merge it allows is recorded as its own `factory.merge`.
    destructive: false,
    record: 'always',
    input: z.object({
      issueNumber: z.number().int().optional(),
      from: z.string().max(64),
      to: z.string().max(64),
      change: z.enum(['same', 'adjustment']),
      lines: z.number().int().min(0),
      files: z.array(z.string()).max(20),
      /** Of `files`, the ones the base brought (openspec factory-approval-follows-base-code). */
      baseFiles: z.array(z.string()).max(20).optional(),
    }),
  },
  // An issue whose work went to other issues (split, or tracked by existing
  // ones), closed by the factory once every one of them was closed.
  'factory.close_parent': {
    scope: 'project',
    // It closes an issue on GitHub; reopening it undoes that.
    destructive: false,
    record: 'always',
    input: z.object({
      issueNumber: z.number().int(),
      parts: z.array(z.number().int()).max(100),
    }),
  },
  // flow-triggers: a schedule occurrence that started no run.
  'factory.trigger_skipped': {
    scope: 'project',
    destructive: false,
    record: 'always',
    input: z.object({
      triggerId: z.string().max(128),
      flowName: z.string().max(64),
      due: z.string().max(64),
    }),
  },
  'agents.stopped': {
    scope: 'project',
    destructive: true,
    record: 'always',
    input: z.object({ reason: z.enum(['runner-binding-changed', 'runner-revoked']) }),
  },
  // track-user-and-scheduled-actions (design D7).
  'automation.unscheduled': {
    scope: 'project',
    destructive: false,
    record: 'always',
    input: z.object({ automationId: z.string().max(128), schedule: z.string().max(256) }),
  },
  'automation.skipped': {
    scope: 'project',
    destructive: false,
    record: 'always',
    input: z.object({ automationId: z.string().max(128), runningSince: z.string().max(64) }),
  },
  'github.write': {
    scope: 'project',
    destructive: true,
    record: 'always',
    input: z.object({
      action: z.enum(['pr-merge', 'pr-revert-file', 'repo-publish', 'issue-delete']),
      prNumber: z.number().int().optional(),
      filePath: z.string().max(1024).optional(),
      repo: z.string().max(256).optional(),
    }),
  },
  'git.destructive': {
    scope: 'project',
    destructive: true,
    record: 'always',
    input: z.object({
      action: z.enum(['discard', 'reset-hard', 'stash-drop', 'rewind', 'restore']),
      paths: z
        .array(z.string().max(1024))
        .transform((paths) => paths.slice(0, GIT_DESTRUCTIVE_PATHS_MAX))
        .optional(),
      fromHead: z.string().max(64).optional(),
      toHead: z.string().max(64).optional(),
      stashIndex: z.number().int().min(0).optional(),
      messageId: z.string().max(128).optional(),
    }),
  },
  // track-pipeline-runs: a review pipeline run started by a commit.
  'pipeline.run': {
    scope: 'thread',
    destructive: true,
    record: 'always',
    input: z.object({
      pipelineId: z.string().max(128),
      commitSha: z.string().max(64).optional(),
    }),
  },
} as const satisfies Record<
  string,
  {
    scope: 'none' | 'project' | 'thread';
    destructive: boolean;
    record: 'always' | 'on-failure';
    input: z.ZodType;
  }
>;

export type ActivityKind = keyof typeof ACTIVITY_KINDS;

export type ActivityInput<K extends ActivityKind> = z.output<(typeof ACTIVITY_KINDS)[K]['input']>;

export function isActivityKind(kind: string): kind is ActivityKind {
  return Object.hasOwn(ACTIVITY_KINDS, kind);
}

/** An activity as a runner or a server caller reports it: its kind and its still unchecked input. */
export interface ReportedActivityInput {
  kind: string;
  input?: unknown;
}

/**
 * Validates an activity input against its kind. Returns the stripped input, or
 * null for an unknown kind or an input that does not match.
 */
export function parseActivityInput({
  kind,
  input,
}: ReportedActivityInput): Activity['input'] | null {
  if (!isActivityKind(kind)) return null;
  const parsed = ACTIVITY_KINDS[kind].input.safeParse(input ?? {});
  return parsed.success ? parsed.data : null;
}

/** True for a kind whose successful runs leave no activity (design D5). */
export function recordsOnlyFailures(kind: string): boolean {
  return isActivityKind(kind) && ACTIVITY_KINDS[kind].record === 'on-failure';
}

/** True for a kind the panel marks as destructive; false for an unknown kind. */
export function isDestructiveKind(kind: string): boolean {
  return isActivityKind(kind) && ACTIVITY_KINDS[kind].destructive;
}

// ── Origin and effects (design D4) ────────────────────────────────────────

export const ACTIVITY_ORIGINS = [
  'user',
  'implicit',
  'system',
] as const satisfies readonly ActivityOrigin[];

export function isActivityOrigin(value: unknown): value is ActivityOrigin {
  return typeof value === 'string' && ACTIVITY_ORIGINS.some((origin) => origin === value);
}

export const ACTIVITY_EFFECTS = [
  'worktree-removed',
  'branch-deleted',
  'command-stopped',
  'terminal-closed',
  'directory-removed',
  'branch-checked-out',
  'changes-stashed',
  'sandbox-stopped',
  'sandbox-destroyed',
  'pr-merged',
  'pr-closed',
  'remote-branch-deleted',
  'agent-stopped',
  'factory-disabled',
  'repo-published',
  'issue-deleted',
  'file-reverted',
  'changes-discarded',
  'commits-reset',
  'stash-dropped',
  'code-rewound',
  'snapshot-saved',
  'commit-created',
] as const satisfies readonly ActivityEffectType[];

/** The most effects an activity keeps, and the longest name of one. */
export const ACTIVITY_EFFECTS_MAX = 20;
export const ACTIVITY_EFFECT_TARGET_MAX = 512;

const effectSchema = z.object({
  effect: z.enum(ACTIVITY_EFFECTS),
  target: z.string(),
});

/** An activity report whose `effects` field is still unchecked. */
export interface ReportedActivityEffects {
  effects?: unknown;
}

/**
 * Keeps the well-formed effects of a reported list: unknown effects and extra
 * fields are dropped, the list is capped at 20 and each target at 512
 * characters. Anything that is not a list reads as null.
 */
export function parseActivityEffects({
  effects: raw,
}: ReportedActivityEffects): ActivityEffect[] | null {
  if (!Array.isArray(raw)) return null;
  const effects: ActivityEffect[] = [];
  for (const item of raw) {
    if (effects.length >= ACTIVITY_EFFECTS_MAX) break;
    const parsed = effectSchema.safeParse(item);
    if (!parsed.success) continue;
    effects.push({
      effect: parsed.data.effect,
      target: parsed.data.target.slice(0, ACTIVITY_EFFECT_TARGET_MAX),
    });
  }
  return effects;
}

/** The longest title and error text an activity records. */
export const ACTIVITY_TITLE_MAX = 200;
export const ACTIVITY_ERROR_MAX = 4000;
export const ACTIVITY_STEP_MAX = 200;
