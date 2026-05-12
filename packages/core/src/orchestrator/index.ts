/**
 * @funny/core/orchestrator — pure logic for the orchestrator scheduler.
 *
 * No DB, no HTTP, no async. The service layer in `packages/server`
 * builds the inputs and applies the planner's output. Tests against
 * this module run synchronously and exhaustively cover the rules.
 */

export type {
  RunRef,
  RetryEntry,
  SlotPolicy,
  EligibilityInput,
  DispatchPlan,
  SkippedReason,
  OrchestratorError,
  OrchestratorErrorCode,
} from './types.js';

export { nextRetryDelayMs } from './backoff.js';
export { isStalled } from './stall.js';
export { compareThreadPriority, sortByPriority } from './priority.js';
export { checkEligibility, countRunningForUser, type EligibilityOutcome } from './eligibility.js';
export { planDispatch } from './plan-dispatch.js';
