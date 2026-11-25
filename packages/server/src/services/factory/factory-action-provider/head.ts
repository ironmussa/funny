/**
 * @domain subdomain: Issue Factory
 * @domain subdomain-type: core
 * @domain type: adapter
 * @domain layer: application
 *
 * The factory's look at its pull request's head commit: the server's checks
 * of it (weakened tests, risk class) and the review verdicts it publishes there.
 */

import {
  contractOf,
  reviewAllowsMerge,
  type FactoryReviewVerdict,
  type FactoryRisk,
  type FactoryTriage,
} from '@funny/shared/contracts/factory';

import { log } from '../../../lib/logger.js';
import { metric } from '../../../lib/telemetry.js';
import { reviewComment, reviewHeadline } from '../factory-review.js';
import { classifyRisk, UNREADABLE_RISK_KEY } from '../factory-risk.js';
import { checkTestWeakening } from '../factory-test-weakening.js';
import type { ActionCore } from './core.js';
import { MAX_RECORDED_PATHS, type ClassifiedHead } from './shared.js';

/** What the head checks read of the rest of the provider. */
interface HeadCheckLinks {
  /** The run's triage now (its contract's risk hints class the change). */
  triage(): FactoryTriage | null;
}

/** Class the pull request's head and publish review verdicts on it. */
export function createHeadChecks(core: ActionCore, links: HeadCheckLinks) {
  const { deps, scope, state, pullRequest } = core;
  /**
   * Check the pull request's head commit for weakened tests and class its risk,
   * once per commit, and store the class on the run. A change that cannot be
   * read is high risk: what was not read was not checked.
   */
  async function classifyHead(): Promise<ClassifiedHead | null> {
    const pr = pullRequest();
    if (!pr) return null;
    const head = await deps.github.pullRequests.pullHead(pr);
    if (head.isErr()) return null;
    const sha = head.value.sha;
    if (state.classified?.sha === sha) return state.classified;
    const files = await deps.github.pullRequests.changedFiles(pr);
    const findings = files.isOk() ? checkTestWeakening(files.value) : [];
    const risk: FactoryRisk = files.isOk()
      ? classifyRisk({
          headSha: sha,
          change: files.value,
          findings,
          sensitivePaths: deps.sensitivePaths,
          maxLowRiskLines: deps.maxLowRiskLines,
          sizeIgnoredPaths: deps.sizeIgnoredPaths,
          riskHints: contractOf({ triage: links.triage() })?.riskHints,
          lintCleanup: (await deps.lintCleanup?.()) ?? false,
        })
      : {
          headSha: sha,
          level: 'high',
          reasons: [`the change could not be read: ${files.error.message}`],
          keys: [UNREADABLE_RISK_KEY],
        };
    if (files.isOk()) {
      risk.changedLines = files.value.files.reduce((n, f) => n + f.additions + f.deletions, 0);
      risk.paths = files.value.files.slice(0, MAX_RECORDED_PATHS).map((f) => f.path);
      deps.onChangeSize?.(risk.changedLines);
    }
    state.classified = { sha, findings, risk };
    await deps.record({ risk });
    metric('factory.integration_event', 1, {
      type: 'sum',
      attributes: { event: `risk_${risk.level}`, repo: scope.repo },
    });
    return state.classified;
  }

  /**
   * Put a verdict on the run's pull request. Best effort: a failure is logged
   * and counted, and the verdict the run stored still decides the merge.
   */
  async function publishVerdict(verdict: FactoryReviewVerdict) {
    const pr = pullRequest();
    if (!pr) return { comment: false, status: false };
    const published = await deps.github.pullRequests.publishReview(pr, {
      sha: verdict.sha,
      allowsMerge: reviewAllowsMerge(verdict),
      body: reviewComment(verdict),
      description: reviewHeadline(verdict),
    });
    if (published.isOk()) return { comment: true, status: published.value.status };
    log.warn('Issue factory could not publish the review verdict', {
      namespace: 'factory',
      runId: scope.runId,
      sha: verdict.sha,
      error: published.error.message,
    });
    metric('factory.integration_event', 1, {
      type: 'sum',
      attributes: { event: 'review_unpublished', repo: scope.repo },
    });
    return { comment: false, status: false };
  }

  /** The `funny/review` status of a verdict carried to a base-merge commit (best effort). */
  async function publishCarriedStatus(verdict: FactoryReviewVerdict): Promise<boolean> {
    const pr = pullRequest();
    if (!pr) return false;
    const from = verdict.carriedFrom ? ` (kept from ${verdict.carriedFrom.slice(0, 8)})` : '';
    const published = await deps.github.pullRequests.publishReview(pr, {
      sha: verdict.sha,
      allowsMerge: reviewAllowsMerge(verdict),
      description: `${reviewHeadline(verdict)}${from}`.slice(0, 140),
    });
    return published.isOk() && published.value.status;
  }

  return { classifyHead, publishVerdict, publishCarriedStatus };
}
