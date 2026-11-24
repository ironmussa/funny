/**
 * @domain subdomain: Issue Factory
 * @domain subdomain-type: core
 * @domain type: domain-service
 * @domain layer: application
 *
 * The `integrate` step of a factory flow (openspec factory-integration D5,
 * D7): the runner merges the base branch into the run's branch in the run's
 * own checkout, with the merge driver, rerere and the declared regenerators,
 * runs the declared checks and pushes. The server only asks and reads the
 * outcome:
 *
 * - `up-to-date` / `merged`: ok, the flow goes on to CI with the new head.
 * - `conflict`: ok with `outcome: conflict` and feedback (the conflicted paths
 *   and what the base changed there), so the merge loop sends it to `address`.
 * - `failed`: the step fails.
 *
 * Review freshness: a merge that settled nothing (no path changed on both
 * sides, nothing regenerated) keeps the review of the commit before it; a merge
 * that settled something changed code nobody reviewed, so the review gate runs
 * again, limited to the settled paths (`integrationOf`).
 */

import type { FactoryRunMetrics } from '@funny/shared/contracts/factory';
import type { IntegrateConfig } from '@funny/workflows';
import type { ActionResult } from '@funny/workflows/compiler';
import type { Result } from 'neverthrow';

import {
  runStepOnRunner,
  type FactoryStepDeps,
  type IntegrateStepResult,
} from './factory-step-runner.js';

/** What an integration merge settled, for the review of the commit it made. */
export interface IntegrationScope {
  /** The commit before the merge (its review may hold for the pull request's own change). */
  from: string;
  /** Paths changed on both sides that the merge settled, and the regenerated ones. */
  paths: string[];
}

export interface FactoryIntegrateDeps {
  steps?: FactoryStepDeps;
  /** The run's checkout: the implementing thread. */
  threadId(): string | undefined;
  branch: string;
  /** The repository's default branch, merged in. */
  defaultBranch?: () => PromiseLike<Result<string, { message: string }>>;
  config: IntegrateConfig;
  signal: AbortSignal;
  metrics(): FactoryRunMetrics;
  count(next: FactoryRunMetrics, attributes: Record<string, string>): Promise<void>;
  /** The merge only brought the base in: the review and proof of `from` hold for `to`. */
  carry(from: string, to: string): Promise<void>;
  /**
   * A conflict is about to go to the implementing agent: counts the round, or
   * returns the result that parks the run when its merge rounds are spent.
   */
  toImplementer(): Promise<ActionResult | null>;
}

/** The whole integrate step may run for at most an hour (the runner refuses more). */
const INTEGRATE_TIMEOUT_MS = 3_600_000;

/** What the implementing agent is told when the base does not merge in by itself. */
function conflictFeedback(result: IntegrateStepResult, base: string): string {
  const diff = result.baseDiff.trim();
  return [
    `Merging the base branch ${base} into this branch left conflicts that could not be settled without you, in:`,
    ...result.conflictedPaths.map((path) => `- ${path}`),
    '',
    `Merge origin/${base} into the branch (a merge, never a rebase), resolve them keeping both changes' intent, run the tests, commit and push.`,
    ...(diff
      ? [
          '',
          `What ${base} changed in those paths since this branch left it:`,
          '```diff',
          diff,
          '```',
        ]
      : []),
  ].join('\n');
}

export function createFactoryIntegrate(deps: FactoryIntegrateDeps) {
  /** Merge commits this run made, by sha, with what they settled. */
  const integrations = new Map<string, IntegrationScope>();

  /** Count the round; `parked`: its conflict did not go to the agent, the run waits for a person. */
  async function counted(result: IntegrateStepResult, parked: boolean): Promise<void> {
    if (result.outcome === 'up-to-date' || result.outcome === 'failed') return;
    const metrics = deps.metrics();
    const settled =
      result.outcome === 'merged' &&
      result.resolvedPaths.length + result.regeneratedPaths.length > 0;
    await deps.count(
      {
        ...metrics,
        integrateRounds: metrics.integrateRounds + 1,
        conflictsResolvedWithoutLlm: metrics.conflictsResolvedWithoutLlm + (settled ? 1 : 0),
        conflictsSentToAgent:
          metrics.conflictsSentToAgent + (result.outcome === 'conflict' && !parked ? 1 : 0),
        weaveIntegrations: metrics.weaveIntegrations + (result.weave ? 1 : 0),
      },
      { event: `integrate_${result.outcome}` },
    );
  }

  /** The step's result for the flow, after review freshness is applied. */
  async function resultOf(result: IntegrateStepResult, base: string): Promise<ActionResult> {
    const metadata = {
      outcome: result.outcome,
      headBefore: result.headBefore,
      headAfter: result.headAfter,
      resolvedPaths: result.resolvedPaths,
      regeneratedPaths: result.regeneratedPaths,
      conflictedPaths: result.conflictedPaths,
      weave: result.weave,
      // For templates: a section that shows only when the implementer must resolve it.
      conflict: result.outcome === 'conflict',
    };
    if (result.outcome === 'failed') return { ok: false, error: result.message, metadata };
    if (result.outcome === 'conflict') {
      const parked = await deps.toImplementer();
      await counted(result, parked !== null);
      if (parked) return parked;
      const feedback = conflictFeedback(result, base);
      return { ok: true, output: 'conflict', metadata: { ...metadata, feedback } };
    }
    if (result.outcome === 'merged') {
      const paths = [...new Set([...result.resolvedPaths, ...result.regeneratedPaths])];
      if (paths.length === 0) await deps.carry(result.headBefore, result.headAfter);
      else integrations.set(result.headAfter, { from: result.headBefore, paths });
    }
    return { ok: true, output: result.outcome, metadata };
  }

  return {
    /** What the integration merge `sha` settled, when this run made it and it settled something. */
    integrationOf: (sha: string): IntegrationScope | null => integrations.get(sha) ?? null,

    async integrate(): Promise<ActionResult> {
      if (!deps.steps) {
        return {
          ok: false,
          error: 'integrate is not available: this server cannot run factory steps on a runner.',
        };
      }
      const threadId = deps.threadId();
      if (!threadId) {
        return {
          ok: false,
          error: 'integrate needs the run checkout: an agent step has to start it first.',
        };
      }
      if (!deps.defaultBranch)
        return { ok: false, error: 'integrate: the base branch is unknown.' };
      const base = await deps.defaultBranch();
      if (base.isErr()) return { ok: false, error: `integrate: ${base.error.message}` };
      const run = await runStepOnRunner(
        deps.steps,
        threadId,
        {
          kind: 'integrate',
          baseBranch: base.value,
          branch: deps.branch,
          regenerators: deps.config.regenerators,
          checks: deps.config.checks,
          timeoutMs: INTEGRATE_TIMEOUT_MS,
        },
        deps.signal,
      );
      if (run.kind === 'unavailable')
        return { ok: false, error: `integrate could not run: ${run.why}` };
      if (run.result.kind !== 'integrate')
        return { ok: false, error: 'integrate: unexpected result.' };
      if (run.result.outcome !== 'conflict') await counted(run.result, false);
      return resultOf(run.result, base.value);
    },
  };
}
