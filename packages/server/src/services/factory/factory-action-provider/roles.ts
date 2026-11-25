/**
 * @domain subdomain: Issue Factory
 * @domain subdomain-type: core
 * @domain type: adapter
 * @domain layer: application
 *
 * The read-only roles of a factory run, triage and review, built on the
 * run's deps with the provider's own checks and publishing.
 */

import { contractOf, type FactoryReviewVerdict } from '@funny/shared/contracts/factory';
import { err, ok } from 'neverthrow';

import { createFactoryReviewer, type FactoryReviewerDeps } from '../factory-review.js';
import type { FactoryRunStage } from '../factory-runs.js';
import { roleThreadWait } from '../factory-thread-waits.js';
import { createFactoryTriage } from '../factory-triage.js';
import type { ActionCore } from './core.js';
import { reviewCounted, type ClassifiedHead, type IssueRunScope } from './shared.js';
import type { WorktreeBase } from './threads.js';

/** What the roles read of the rest of the provider. */
interface RoleLinks {
  worktreeBase(): Promise<WorktreeBase>;
  classifyHead(): Promise<ClassifiedHead | null>;
  publishVerdict(verdict: FactoryReviewVerdict): Promise<{ comment: boolean; status: boolean }>;
  publishCarriedStatus(verdict: FactoryReviewVerdict): Promise<boolean>;
  enterStage(stage: FactoryRunStage): Promise<void>;
  integrationOf: NonNullable<FactoryReviewerDeps['integrationOf']>;
  diffBase(): string | null;
}

/** The run's triager and reviewer. */
export function createRunRoles(core: ActionCore, links: RoleLinks) {
  const { deps, scope, state, count, pullRequest, reader } = core;
  const { worktreeBase, classifyHead, publishVerdict, publishCarriedStatus, enterStage } = links;
  const offBranch = deps.continuation?.followUpOffBranch;
  const askAgain =
    offBranch && deps.continuation
      ? { send: offBranch, completedAt: deps.continuation.completedAt }
      : undefined;

  // Triage and review judge a change against the run's issue. A run without
  // one never reaches them: its flow is refused when it has such a step
  // (`validateFlowForSubject`), and the step entries below refuse again. The
  // roles are still built, on a scope whose issue number is never used.
  const roleScope: IssueRunScope = { ...scope, issueNumber: scope.issueNumber ?? 0 };
  // A role's answer left in a turn that never ended is taken, and its thread stopped.
  const waitRole = roleThreadWait(deps.waitRoleThread ?? deps.waitThread, deps.abandon, scope);

  const triager = createFactoryTriage({
    scope: roleScope,
    issueUrl: scope.issueUrl ?? null,
    stored: deps.triage ?? null,
    since: deps.admittedAt ?? new Date(0).toISOString(),
    signal: deps.signal,
    launch: deps.launch,
    findLaunched: async (prefix, since) => (await deps.findTriageThread?.(prefix, since)) ?? null,
    waitThread: waitRole,
    finalMessage: async (threadId) => (await deps.lastThreadMessage?.(threadId)) ?? null,
    followUp: askAgain,
    worktreeBase,
    releaseWorkspace: deps.releaseRoleWorkspace,
    comment: async (body) => {
      const posted = await deps.github.commentOnIssue(reader, roleScope.issueNumber, body);
      return posted.isOk() ? ok(undefined) : err(posted.error.message);
    },
    // A run with a pull request has no implementer to start: it waits for no
    // paths, or the runs started after it would merge first (openspec
    // factory-merge-fewer-bounces, D5).
    busyPaths: deps.busyPaths && (async () => (pullRequest() ? [] : deps.busyPaths!())),
    issueUpdatedAt: deps.issueUpdatedAt,
    issueText: deps.issueText,
    hold: deps.holdForPaths,
    split: deps.split,
    exclusive: deps.exclusive,
    record: deps.record,
    count: (event) => count(state.metrics, { event }),
  });

  const reviewer = createFactoryReviewer({
    scope: roleScope,
    issueUrl: scope.issueUrl ?? null,
    issueText: deps.issueText,
    reviews: deps.reviews ?? [],
    since: deps.admittedAt ?? new Date(0).toISOString(),
    signal: deps.signal,
    pullRequest,
    prUrl: () => state.prUrl,
    headSha: async () => {
      const pr = pullRequest();
      if (!pr) return err('The run has no pull request yet.');
      const head = await deps.github.pullRequests.pullHead(pr);
      return head.isOk() ? ok(head.value.sha) : err(head.error.message);
    },
    classify: classifyHead,
    launch: deps.launch,
    findLaunched: async (prefix, since) => (await deps.findReviewThread?.(prefix, since)) ?? null,
    waitThread: waitRole,
    finalMessage: async (threadId) => (await deps.lastThreadMessage?.(threadId)) ?? null,
    followUp: askAgain,
    contract: () => contractOf({ triage: triager.current() }),
    abandon: deps.abandon,
    worktreeBase,
    releaseWorkspace: deps.releaseRoleWorkspace,
    otherPullRequests: deps.otherPullRequests,
    acquireSlot: deps.reviewSlot,
    publish: publishVerdict,
    publishStatus: publishCarriedStatus,
    record: deps.record,
    enterReview: () => enterStage('review'),
    count: (event) => count(reviewCounted(state.metrics, event), { event }),
    integrationOf: (sha) => links.integrationOf(sha),
    diffBase: () => links.diffBase(),
  });

  return { triager, reviewer };
}
