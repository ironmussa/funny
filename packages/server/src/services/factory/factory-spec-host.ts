/**
 * @domain subdomain: Issue Factory
 * @domain subdomain-type: core
 * @domain type: adapter
 * @domain layer: infrastructure
 *
 * The spec stage's host (openspec factory-spec-stage): the watcher's runner,
 * GitHub and push ports, as the spec writer (`factory-spec.ts`) reaches them.
 * Every thread is the factory's enabler's, on their own runtime.
 */

import { sendPush } from '../web-push.js';
import { findLaunchedThread, threadCompletedAt } from './factory-flow-runs-support.js';
import type { createFactoryRunsRepository } from './factory-runs.js';
import { getWatchedFactory, type WatchedFactory } from './factory-settings.js';
import type { FactorySpecHost, SpecTarget } from './factory-spec.js';
import { cleanupFactoryWorktrees, sendFactoryFollowUp } from './factory-thread-requests.js';
import {
  createThreadWaits,
  lastThreadMessage,
  ROLE_QUIET_ANSWER_MS,
} from './factory-thread-waits.js';
import { launchFor, type FactoryWatcherDeps } from './factory-watcher-state.js';

/** Where a factory's runs execute, or why they cannot now (`checkFactoryTarget`). */
type TargetOf = (
  factory: WatchedFactory,
) => Promise<{ mode: SpecTarget['mode']; repo: string } | { reason: string } | null>;

export function createSpecHost(
  d: FactoryWatcherDeps,
  runs: ReturnType<typeof createFactoryRunsRepository>,
  targetOf: TargetOf,
): FactorySpecHost {
  const waitThread = d.waitThread ?? createThreadWaits({ quietAnswerMs: ROLE_QUIET_ANSWER_MS });
  const launch = launchFor(d);
  return {
    runs,
    target: async (run) => {
      if (run.issueNumber === null) return null;
      const factory = await getWatchedFactory(run.factoryId);
      if (!factory) return null;
      const target = await targetOf(factory);
      if (!target || 'reason' in target) return null;
      return {
        userId: factory.userId,
        projectId: factory.projectId,
        repo: target.repo,
        mode: target.mode,
        issueNumber: run.issueNumber,
        issueTitle: run.issueTitle ?? '',
        baseBranch: run.baseBranch ?? (factory.baseBranch || null),
      };
    },
    launch: (userId, body) => launch({ userId, body }),
    findLaunched: (scope, prefix, since) => findLaunchedThread(scope, prefix, since, true),
    finalMessage: d.lastThreadMessage ?? lastThreadMessage,
    followUp: (userId, threadId, content) =>
      d.followUp
        ? d.followUp(userId, threadId, content)
        : sendFactoryFollowUp(d.ports, userId, threadId, content),
    waitThread,
    completedAt: threadCompletedAt,
    issueText: async (target) => {
      const reader = { repo: target.repo, ownerId: target.userId, projectId: target.projectId };
      const text = await d.github.issueText(reader, target.issueNumber);
      return text.isOk() ? text.value : null;
    },
    releaseWorkspace: async (userId, threadId) => {
      await cleanupFactoryWorktrees(d.ports, userId, [threadId], d.browserEvents, {
        keepUnsaved: true,
        // A read-only role whose answer is stored: the same cleanup as a finished review.
        reason: 'review-finished',
      });
    },
    notify: (userId, notice) => (d.notify ?? sendPush)(userId, notice),
  };
}
