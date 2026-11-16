/**
 * @funny/orchestrator — the issue factory's orchestrator (see GLOSSARY.md and
 * docs/adr/0001-standalone-issue-factory.md).
 *
 * Layout (adapters/ and bin/ as in the thread scheduler package, plus explicit
 * domain/ and ports/ folders):
 *   domain/   pure logic: the state machine and the events the factory publishes
 *   ports/    interfaces the factory's domain will depend on (issue source, …)
 *   adapters/ implementations of the ports (GitHub tracker, JSONL event bus)
 *   bin/      entry points: `orchestrator` (start, status) and `step` (runs in a workspace)
 *
 * The factory itself is not built yet; the entry points are stubs.
 */

export { StateMachine, TransitionError } from './domain/state-machine.js';
export type { PipelineEvent, PipelineEventType } from './domain/events.js';
export type {
  Tracker,
  Issue,
  IssueDetail,
  IssueFilter,
  IssueComment,
  IssueLabel,
  IssueUser,
} from './ports/tracker.js';
export { GitHubTracker } from './adapters/github-tracker.js';
export { EventBus } from './adapters/event-bus.js';
export { AsyncMutex } from './infrastructure/async-mutex.js';
export { loadConfig } from './config/loader.js';
export type { PipelineServiceConfig } from './config/schema.js';
export {
  PRReviewer,
  buildReviewSystemPrompt,
  buildReviewUserPrompt,
  formatReviewBody,
  decideReviewEvent,
} from './agents/reviewer/index.js';
export type {
  ReviewOptions,
  PRReviewerConfig,
  ParsedReviewOutput,
  ParsedFinding,
} from './agents/reviewer/index.js';
