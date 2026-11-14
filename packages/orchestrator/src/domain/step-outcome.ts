/**
 * How one step of a factory run ended.
 *
 * An agent failure (checks that never pass, no changes, the agent erroring) is
 * not retried automatically; an infrastructure failure (git, GitHub, the
 * workspace) may be.
 */

import { z } from 'zod';

/** The outcome as the step writes it to its exit marker (extra fields are ignored). */
export const stepOutcomeSchema = z.union([
  z.object({ kind: z.literal('pr_opened'), prUrl: z.string(), sessionId: z.string().optional() }),
  /** A `fix` step pushed its changes to the pull request's branch. */
  z.object({ kind: z.literal('pushed'), sessionId: z.string().optional() }),
  z.object({
    kind: z.literal('failed'),
    failure: z.enum(['agent', 'infra']),
    reason: z.string(),
    sessionId: z.string().optional(),
  }),
]);

export type StepOutcome = z.infer<typeof stepOutcomeSchema>;
export type FailureKind = Extract<StepOutcome, { kind: 'failed' }>['failure'];
