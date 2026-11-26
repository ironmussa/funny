/**
 * @domain subdomain: Issue Factory
 * @domain subdomain-type: core
 * @domain type: adapter
 * @domain layer: application
 *
 * What every part of the factory's `ActionProvider` shares: the run's deps,
 * its mutable progress (`ProviderState`), its counters and its pull request.
 */

import { EMPTY_FACTORY_RUN_METRICS, type FactoryRunMetrics } from '@funny/shared/contracts/factory';

import { metric } from '../../../lib/telemetry.js';
import type { WaitCiOptions } from '../factory-ci-actions.js';
import { prNumberOf, type FactoryPullRequestRef } from '../factory-pull-requests.js';
import {
  runReaderOf,
  type ClassifiedHead,
  type FactoryActionProviderDeps,
  type FactoryRunScope,
  type HeldProof,
} from './shared.js';

/** What one execution of a run's flow learns and changes as its steps act. */
interface ProviderState {
  /** Agent steps called so far (the legacy replay numbers them by call order). */
  agentSteps: number;
  prUrl: string | null;
  /** Set while the run's next agent thread was being started when it was interrupted. */
  pendingLaunch: string | null;
  metrics: FactoryRunMetrics;
  /** The node a regenerable merge (D9) sends a conflict back to, once `merge` named one. */
  regenerating?: string;
  /**
   * The last proof this execution ran: its record (which commit), whether its
   * verdict allows a merge, and whether its check is on GitHub (auto-merge
   * needs it).
   */
  lastProof: HeldProof | null;
  /**
   * What the server found in the last classified commit of the pull request:
   * its weakened tests and its risk class (change factory-agent-roles, D6).
   */
  classified: ClassifiedHead | null;
  /** Whether the run waits for or holds the merge slot (an early integration leaves it to the queue). */
  atMerge: boolean;
  /** The `wait_ci` options of the flow's last look, reused when the merge waits on a new head. */
  lastWaitCi: WaitCiOptions;
}

/** The enabler's read of the repository: the App token capped by their access. */
interface RepoReader {
  repo: string;
  ownerId: string;
  projectId: string;
}

/** The run's deps, progress and the helpers every step uses. */
export interface ActionCore {
  deps: FactoryActionProviderDeps;
  scope: FactoryRunScope;
  /** The run's agent threads, in step order (the display list). */
  threadIds: string[];
  state: ProviderState;
  /** Add to the run's counters and store them with the run. */
  count(next: FactoryRunMetrics | null, attributes: Record<string, string>): Promise<void>;
  /** The run's pull request, once it has one. */
  pullRequest(): FactoryPullRequestRef | null;
  reader: RepoReader;
}

export function createActionCore(deps: FactoryActionProviderDeps): ActionCore {
  const { scope } = deps;
  const state: ProviderState = {
    agentSteps: 0,
    prUrl: deps.prUrl,
    pendingLaunch: deps.launchStartedAt,
    metrics: { ...EMPTY_FACTORY_RUN_METRICS, ...deps.metrics },
    lastProof: null,
    classified: null,
    atMerge: false,
    lastWaitCi: {},
  };

  async function count(next: FactoryRunMetrics | null, attributes: Record<string, string>) {
    if (!next) return;
    state.metrics = next;
    metric('factory.integration_event', 1, {
      type: 'sum',
      attributes: { ...attributes, repo: scope.repo },
    });
    await deps.record({ metrics: state.metrics });
  }

  const pullRequest = (): FactoryPullRequestRef | null => {
    const number = prNumberOf(state.prUrl);
    if (number === null) return null;
    return {
      repo: scope.repo,
      number,
      branch: scope.branch,
      userId: scope.userId,
      projectId: scope.projectId,
    };
  };

  return {
    deps,
    scope,
    threadIds: [...deps.threadIds],
    state,
    count,
    pullRequest,
    reader: runReaderOf(scope),
  };
}
