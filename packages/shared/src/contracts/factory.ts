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

export const saveFactorySettingsInput = z
  .object({
    projectId,
    enabled: z.boolean(),
    label: label.optional(),
    flowName: flowName.optional(),
    maxConcurrent: z.number().int().min(1).max(20).optional(),
  })
  .strict();

export type SaveFactorySettingsInput = z.input<typeof saveFactorySettingsInput>;

export interface FactorySettings {
  projectId: string;
  enabled: boolean;
  label: string;
  flowName: string;
  maxConcurrent: number;
  /** Why the factory cannot make progress now (e.g. its runner is offline), or null. */
  blockedReason: string | null;
  updatedAt: string;
}

export type FactoryRunState =
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
  startedAt: string;
  completedAt: string | null;
}
