/**
 * The issue factory of a project (change issue-factory): inputs and answers of
 * the `factory` tRPC procedures. Each user configures their own factory for a
 * project; runs are written by the server's watcher and only read here.
 */

import { z } from 'zod';

const projectId = z.string().min(1);

/**
 * A flow is named like a workflow file (`issue-to-merge`): it is looked up in
 * the workflow catalog, so path separators and leading dots are refused.
 */
const flowName = z
  .string()
  .trim()
  .regex(
    /^[a-z0-9][a-z0-9._-]{0,63}$/,
    'Flow names use lowercase letters, digits, ".", "_" and "-"',
  );

/**
 * One GitHub label. A comma would make the issue search match several labels
 * at once (GitHub reads `labels=a,b` as "both"), so it is refused.
 */
const label = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine((value) => !value.includes(','), 'A label cannot contain a comma');

export const factoryProjectInput = z.object({ projectId }).strict();

/** One run of the caller's factory for the project (stop, retry). */
export const factoryRunInput = z.object({ projectId, runId: z.string().min(1) }).strict();

/**
 * What a factory admits (change factory-manual-queue): `manual`, only the
 * issues sent to it; `automatic`, also the open issues carrying its label.
 */
export const factoryMode = z.enum(['manual', 'automatic']);
export type FactoryMode = z.infer<typeof factoryMode>;

export const saveFactorySettingsInput = z
  .object({
    projectId,
    enabled: z.boolean(),
    mode: factoryMode.optional(),
    label: label.optional(),
    flowName: flowName.optional(),
    maxConcurrent: z.number().int().min(1).max(20).optional(),
  })
  .strict();

export type SaveFactorySettingsInput = z.input<typeof saveFactorySettingsInput>;

export interface FactorySettings {
  projectId: string;
  /** Running (true) or paused (false); separate from the mode. */
  enabled: boolean;
  mode: FactoryMode;
  /** The label automatic mode admits; kept (and unused) in manual mode. */
  label: string;
  flowName: string;
  maxConcurrent: number;
  /** Why the factory cannot make progress now (e.g. its runner is offline), or null. */
  blockedReason: string | null;
  updatedAt: string;
}

export type FactoryRunState =
  /** Sent to the factory and waiting in its queue; holds no concurrency slot. */
  | 'requested'
  | 'queued'
  | 'working'
  | 'pr_open'
  | 'waiting_ci'
  | 'fixing'
  | 'waiting_human'
  | 'merged'
  | 'failed'
  | 'stopped';

export interface FactoryRun {
  id: string;
  factoryId: string;
  issueNumber: number;
  prUrl: string | null;
  state: FactoryRunState;
  currentStep: string | null;
  threadIds: string[];
  /** When the row was written: the send time for a sent issue. */
  startedAt: string;
  completedAt: string | null;
  /** How the issue came in: sent from funny, or found by the label (automatic mode). */
  source: FactoryRunSource;
  /** The flow the run executes; null on runs from before runs recorded their own. */
  flowName: string | null;
  /** Position in the queue while `requested` (lower goes first). */
  queueOrder: number | null;
  /** Why a `requested` run is not admitted yet, or null. */
  waitReason: FactoryWaitReason | null;
}

export type FactoryRunSource = 'manual' | 'label';

/**
 * Why a queued issue waits on another one (GitHub's "blocked by" relation).
 * `blockers` are the issue numbers in the same repository that hold it back.
 */
export interface FactoryWaitReason {
  kind:
    | 'blocker-not-sent'
    | 'blocker-in-progress'
    | 'blocker-waiting-merge'
    | 'blocker-failed'
    /** A blocker in another repository: it counts only by its issue state. */
    | 'blocker-other-repo'
    | 'circular'
    | 'blockers-unreadable';
  blockers: number[];
}

/** At most this many issues per send. */
export const MAX_ISSUES_PER_SEND = 50;

const issueNumber = z.number().int().positive();

/** Send chosen issues of the project's repository to the caller's own factory. */
export const submitFactoryIssuesInput = z
  .object({
    projectId,
    issueNumbers: z.array(issueNumber).min(1).max(MAX_ISSUES_PER_SEND),
    flowName,
  })
  .strict();

export type SubmitFactoryIssuesInput = z.input<typeof submitFactoryIssuesInput>;

/** Why one issue of a send was not queued. */
export type FactorySubmitRefusal =
  | 'not-found'
  | 'closed'
  | 'pull-request'
  | 'already-in-factory'
  | 'unreadable';

export interface FactorySubmitResult {
  /** The queued issues, in queue order. */
  accepted: number[];
  refused: Array<{ issue: number; reason: FactorySubmitRefusal; message: string }>;
}

/** A flow a send may pick. */
export interface FactoryFlowOption {
  name: string;
  source: 'built-in' | 'repository';
}

/** The open blockers of some issues (the send bar's warning). */
export const factoryBlockersInput = z
  .object({ projectId, issueNumbers: z.array(issueNumber).min(1).max(MAX_ISSUES_PER_SEND) })
  .strict();

export interface FactoryIssueBlockers {
  issue: number;
  /** Open blockers in the same repository, and whether the caller's factory has a run for each. */
  blockers: Array<{ issue: number; inFactory: boolean }>;
}

/** What "Clear queue" / "Stop all" did. */
export interface FactoryQueueClearResult {
  /** Waiting issues removed from the queue. */
  cleared: number;
  /** Runs in progress that were stopped (`stopAll` only). */
  stopped: number;
}
