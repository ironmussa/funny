/**
 * How one step of a factory run ended.
 *
 * An agent failure (checks that never pass, no changes, the agent erroring) is
 * not retried automatically; an infrastructure failure (git, GitHub, the
 * workspace) may be.
 */

export type FailureKind = 'agent' | 'infra';

export type StepOutcome =
  | { kind: 'pr_opened'; prUrl: string; sessionId?: string }
  | { kind: 'failed'; failure: FailureKind; reason: string; sessionId?: string };
