/**
 * A factory run's pull request as the orchestrator follows it after the step
 * runner opened it: its CI, its mergeability, and marking it ready. The port
 * and its GitHub implementation live in `@funny/core/github-app`, shared with
 * the server.
 */

export type { AutoMergeResult, CiState, PullRequestCi } from '@funny/core/github-app';
