/**
 * @domain subdomain: Issue Factory
 * @domain subdomain-type: core
 * @domain type: application-service
 * @domain layer: application
 *
 * The `wait_ci` and `merge` workflow steps of a factory run (change
 * factory-flow-execution, group 2), over the run's pull request
 * (`FactoryPullRequests`). Their results have the shape of
 * `@funny/workflows`' `ActionResult` (`ok`, `output`, `error`, `metadata`), so
 * the factory's server `ActionProvider` (group 3) returns them as they are; a
 * non-ok result is a step error, so the flow's `retry` / `on_error` act on it.
 *
 * - `waitCi` polls until a terminal verdict: green (ok), red or conflicting
 *   (not ok, with the failing checks), or the timeout (not ok). A head commit
 *   with no checks reported is treated as pending for a grace period — a push
 *   registers its checks a moment later, and merging before they appear would
 *   skip the CI — and as green ("no CI") after it.
 * - `merge` merges (or enables auto-merge) only on green checks, and reports
 *   the run merged; anything else is not ok and leaves the PR alone.
 * - `required_checks` narrows both to the named checks (a named check not
 *   reported yet is pending); `merge` uses the names of the last `wait_ci`.
 */

import type { CiState, FailingCheck, MergeMethod } from '@funny/core/github-app';
import { sleep as interruptibleSleep } from '@funny/shared/async';

import type {
  FactoryPullRequestErrorKind,
  FactoryPullRequestRef,
  FactoryPullRequests,
} from './factory-pull-requests.js';

/**
 * What a `wait_ci` / `merge` result says besides its output: the CI verdict
 * and its checks, the merge outcome, or the kind of GitHub error. A type
 * alias, not an interface, so it stays assignable to `ActionResult.metadata`.
 */
export type CiActionMetadata = {
  verdict?: 'green' | 'no-checks' | 'red' | 'conflict' | 'blocked' | 'timeout';
  failingChecks?: FailingCheck[];
  blockedChecks?: FailingCheck[];
  kind?: FactoryPullRequestErrorKind;
  outcome?: 'merged' | 'auto-merge-enabled' | 'not-green' | 'not-mergeable';
  method?: MergeMethod;
  branchDeleted?: boolean;
  ci?: CiState['kind'];
};

/** `ActionResult` of `@funny/workflows` (compared structurally). */
export interface CiActionResult {
  ok: boolean;
  output?: string;
  error?: string;
  metadata?: CiActionMetadata;
}

/** `WaitCiOpts` of `@funny/workflows`. */
export interface WaitCiOptions {
  timeoutMs?: number;
  intervalMs?: number;
  requiredChecks?: string[];
}

/** `MergeOpts` of `@funny/workflows`. */
export interface MergeOptions {
  method?: MergeMethod;
  deleteBranch?: boolean;
  auto?: boolean;
  /** Merge exactly this commit (the proved one). */
  sha?: string;
  /** With `sha`: auto-merge when GitHub holds the proof's check (`FactoryMergeOptions`). */
  autoMergeWhenHeld?: boolean;
}

/** How much of each failing check's excerpt the error keeps (its start: the failures; see `excerptOfJobLog`). */
const EXCERPT_CHARS = 4000;
const DEFAULT_CI_TIMEOUT_MS = 60 * 60 * 1000;
const DEFAULT_CI_INTERVAL_MS = 30 * 1000;
/** How long a head commit may report no checks before the repository counts as having no CI. */
export const NO_CHECKS_GRACE_MS = 2 * 60 * 1000;

export interface FactoryCiActionsDeps {
  prs: FactoryPullRequests;
  /** The run's pull request; read on each call (the flow opens it before these steps). */
  pullRequest: () => FactoryPullRequestRef | null;
  /** Cancels a wait when the run is stopped. */
  signal?: AbortSignal;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
  /**
   * Records the run as merged (e.g. `factory_runs.state = 'merged'`). Called
   * only when GitHub merged the PR; with auto-merge enabled it is not merged yet.
   */
  markMerged?: () => Promise<void>;
}

const noPullRequest: CiActionResult = {
  ok: false,
  error: 'The run has no pull request yet: wait_ci and merge need one opened by an earlier step.',
};

/** One failing check as the fix step reads it; null when GitHub gave nothing to show. */
function checkDetail(check: FailingCheck): string | null {
  const lines = [`--- ${check.name} ---`];
  if (check.failedStep) lines.push(`Failed step: ${check.failedStep}`);
  if (check.url) lines.push(`Link: ${check.url}`);
  if (check.excerpt) lines.push(check.excerpt.slice(0, EXCERPT_CHARS));
  return lines.length > 1 ? lines.join('\n') : null;
}

function redResult(ci: Extract<CiState, { kind: 'failing' | 'conflict' }>): CiActionResult {
  if (ci.kind === 'conflict') {
    return {
      ok: false,
      error: 'The pull request conflicts with its base branch.',
      metadata: { verdict: 'conflict' },
    };
  }
  const names = ci.checks.map((check) => check.name).join(', ');
  // The error is what a fix step reads (`LAST_ERROR`): the names (first, as
  // the flow's `should_retry` matches "Failing checks"), the commit checked,
  // then for each check its failed step, its link and the end of its log.
  const commit = ci.sha ? [`Commit checked: ${ci.sha}`] : [];
  const details = ci.checks.map(checkDetail).filter((detail) => detail !== null);
  return {
    ok: false,
    error: [`Failing checks: ${names}`, ...commit, ...details].join('\n\n'),
    metadata: { verdict: 'red', failingChecks: ci.checks },
  };
}

/**
 * Checks that could not run: not retried (the flow's fix loop retries only
 * "Failing checks" and conflicts), so the run waits for the member with why.
 */
function blockedResult(ci: Extract<CiState, { kind: 'blocked' }>): CiActionResult {
  const checks = ci.checks.map((check) => `${check.name} (${check.conclusion}: ${check.excerpt})`);
  return {
    ok: false,
    error: `Checks that need a person, not a code change: ${checks.join('; ')}`,
    metadata: { verdict: 'blocked', blockedChecks: ci.checks },
  };
}

const stopped: CiActionResult = { ok: false, error: 'The run was stopped.' };

/** A terminal verdict for one look at the CI, or null while it is still pending. */
function verdictOf(state: CiState, elapsedMs: number): CiActionResult | null {
  switch (state.kind) {
    case 'green':
      return { ok: true, output: 'green', metadata: { verdict: 'green' } };
    case 'failing':
    case 'conflict':
      return redResult(state);
    case 'blocked':
      return blockedResult(state);
    case 'none':
      return elapsedMs >= NO_CHECKS_GRACE_MS
        ? { ok: true, output: 'no-checks', metadata: { verdict: 'no-checks' } }
        : null;
    default:
      return null;
  }
}

/** The timeout verdict once the next look would land past `timeoutMs`, else null. */
function timedOut(nextLookMs: number, timeoutMs: number): CiActionResult | null {
  if (nextLookMs <= timeoutMs) return null;
  return {
    ok: false,
    error: `The checks did not finish within ${Math.round(timeoutMs / 1000)} s.`,
    metadata: { verdict: 'timeout' },
  };
}

export function createFactoryCiActions(deps: FactoryCiActionsDeps) {
  const sleep = deps.sleep ?? interruptibleSleep;
  const now = deps.now ?? Date.now;

  /** The checks the last `wait_ci` waited on; `merge` holds the PR to the same ones. */
  let required: readonly string[] | undefined;

  async function waitCi(options: WaitCiOptions = {}): Promise<CiActionResult> {
    required = options.requiredChecks?.length ? options.requiredChecks : undefined;
    const pr = deps.pullRequest();
    if (!pr) return noPullRequest;
    return poll(
      pr,
      options.timeoutMs ?? DEFAULT_CI_TIMEOUT_MS,
      options.intervalMs ?? DEFAULT_CI_INTERVAL_MS,
    );
  }

  /** Look at the CI every `intervalMs` until a verdict, the timeout or a stop. */
  async function poll(
    pr: FactoryPullRequestRef,
    timeoutMs: number,
    intervalMs: number,
  ): Promise<CiActionResult> {
    const started = now();
    for (;;) {
      if (deps.signal?.aborted) return stopped;
      const verdict = await lookOnce(pr, now() - started, timeoutMs, intervalMs);
      if (verdict) return verdict;
      const slept = await sleep(intervalMs, deps.signal).then(
        () => true,
        () => false,
      );
      if (!slept) return stopped;
    }
  }

  /** One look: an error, a terminal verdict, the timeout, or null to keep waiting. */
  async function lookOnce(
    pr: FactoryPullRequestRef,
    elapsedMs: number,
    timeoutMs: number,
    intervalMs: number,
  ): Promise<CiActionResult | null> {
    const ci = await deps.prs.ciState(pr, required);
    if (ci.isErr())
      return { ok: false, error: ci.error.message, metadata: { kind: ci.error.kind } };
    return verdictOf(ci.value, elapsedMs) ?? timedOut(elapsedMs + intervalMs, timeoutMs);
  }

  async function merge(options: MergeOptions = {}): Promise<CiActionResult> {
    const pr = deps.pullRequest();
    if (!pr) return noPullRequest;
    const merged = await deps.prs.merge(pr, {
      method: options.method,
      deleteBranch: options.deleteBranch,
      requiredChecks: required,
      sha: options.sha,
      autoMergeWhenHeld: options.autoMergeWhenHeld,
    });
    if (merged.isErr()) {
      return { ok: false, error: merged.error.message, metadata: { kind: merged.error.kind } };
    }
    const outcome = merged.value;
    switch (outcome.kind) {
      case 'merged':
        await deps.markMerged?.();
        return {
          ok: true,
          output: 'merged',
          metadata: {
            outcome: 'merged',
            method: outcome.method,
            branchDeleted: outcome.branchDeleted,
          },
        };
      case 'auto-merge-enabled':
        return {
          ok: true,
          output: 'auto-merge-enabled',
          metadata: { outcome: 'auto-merge-enabled', method: outcome.method },
        };
      case 'not-green':
        return {
          ok: false,
          error: `Not merged: the checks are not green (${outcome.ci.kind}).`,
          metadata: { outcome: 'not-green', ci: outcome.ci.kind },
        };
      default:
        return {
          ok: false,
          error: `Not merged: ${outcome.reason}`,
          metadata: { outcome: 'not-mergeable' },
        };
    }
  }

  return { waitCi, merge };
}
