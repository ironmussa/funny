/**
 * GitHub check runs and branch protection queries for the regression proof gate.
 *
 * - Creating a check run on a commit (requires `checks: write` on the token).
 * - Querying whether a branch's rules require a named check from one App ("held").
 * - Querying whether a branch has commits ahead of the default branch.
 * - Merging a pull request at an exact SHA, never enabling auto-merge.
 */

import { errAsync, okAsync, ResultAsync } from 'neverthrow';

import type { MergeMethod } from './pull-requests.js';
import type { GithubCallError, RepoGithub } from './repo-github.js';

/** The check the issue factory publishes for every regression proof (factory-quality-gates). */
export const REGRESSION_PROOF_CHECK = 'funny/regression-proof';

export type CheckRunConclusion = 'success' | 'failure' | 'neutral' | 'cancelled' | 'timed_out';

export interface CreateCheckRunInput {
  repo: string;
  headSha: string;
  name: string;
  conclusion: CheckRunConclusion;
  summary: string;
  title?: string;
}

export interface CheckRunResult {
  id: number;
  url: string;
}

export type PinnedMergeResult =
  | { kind: 'merged'; method: MergeMethod }
  /** `headMoved`: GitHub answered 409, the head is no longer `sha`; else a requirement is unmet. */
  | { kind: 'not-mergeable'; reason: string; headMoved: boolean };

export interface BranchCompareResult {
  ahead: boolean;
  aheadBy: number;
}

export interface RepoCheckOps {
  createCheckRun(input: CreateCheckRunInput): ResultAsync<CheckRunResult, GithubCallError>;

  pinnedMerge(
    repo: string,
    number: number,
    sha: string,
    method: MergeMethod,
  ): ResultAsync<PinnedMergeResult, GithubCallError>;

  isBranchAhead(
    repo: string,
    base: string,
    head: string,
  ): ResultAsync<BranchCompareResult, GithubCallError>;

  /**
   * Whether GitHub itself holds `checkName` on `branch`: a rule that applies to
   * the branch requires it **from the App `appId`** (rulesets, or classic
   * branch protection). Required from any source, or from another App, is not
   * held: a workflow job of the same name would satisfy such a rule.
   */
  isCheckHeldByApp(
    repo: string,
    branch: string,
    checkName: string,
    appId: number,
  ): ResultAsync<boolean, GithubCallError>;
}

/** `GET /repos/{repo}/rules/branches/{branch}`: the active rules that apply to the branch. */
interface RestBranchRule {
  type: string;
  parameters?: {
    required_status_checks?: Array<{ context: string; integration_id?: number | null }>;
  } | null;
}

/** `GET /repos/{repo}/branches/{branch}`: its classic protection, readable without admin. */
interface RestBranch {
  protection?: {
    required_status_checks?: {
      checks?: Array<{ context: string; app_id?: number | null }>;
    } | null;
  } | null;
}

interface RestCompare {
  ahead_by: number;
  behind_by: number;
  status: string;
}

export function createRepoCheckOps(github: RepoGithub): RepoCheckOps {
  return {
    createCheckRun(input) {
      return github
        .json<{ id: number; html_url: string }>(
          input.repo,
          'POST',
          `/repos/${input.repo}/check-runs`,
          {
            name: input.name,
            head_sha: input.headSha,
            status: 'completed',
            conclusion: input.conclusion,
            output: {
              title: input.title ?? input.name,
              summary: input.summary,
            },
          },
        )
        .map((res) => ({ id: res.id, url: res.html_url }));
    },

    pinnedMerge(repo, number, sha, method) {
      return github
        .json(repo, 'PUT', `/repos/${repo}/pulls/${number}/merge`, {
          merge_method: method,
          sha,
        })
        .map((): PinnedMergeResult => ({ kind: 'merged', method }))
        .orElse((e) =>
          e.status === 405 || e.status === 409
            ? okAsync<PinnedMergeResult, GithubCallError>({
                kind: 'not-mergeable',
                reason: e.message,
                headMoved: e.status === 409,
              })
            : errAsync(e),
        );
    },

    isBranchAhead(repo, base, head) {
      return github
        .json<RestCompare>(repo, 'GET', `/repos/${repo}/compare/${base}...${head}`)
        .map((compare): BranchCompareResult => ({
          ahead: compare.ahead_by > 0,
          aheadBy: compare.ahead_by,
        }))
        .orElse((e) =>
          e.status === 404
            ? okAsync<BranchCompareResult, GithubCallError>({ ahead: false, aheadBy: 0 })
            : errAsync(e),
        );
    },

    isCheckHeldByApp(repo, branch, checkName, appId) {
      const ref = encodeURIComponent(branch);
      // A missing branch or rule set (404) holds nothing.
      const none = <T>(e: GithubCallError) =>
        e.status === 404 ? okAsync<T | null, GithubCallError>(null) : errAsync(e);
      return github
        .json<RestBranchRule[]>(repo, 'GET', `/repos/${repo}/rules/branches/${ref}?per_page=100`)
        .orElse((e) => none<RestBranchRule[]>(e))
        .andThen((rules) => {
          const byRule = (rules ?? []).some(
            (rule) =>
              rule.type === 'required_status_checks' &&
              (rule.parameters?.required_status_checks ?? []).some(
                (check) => check.context === checkName && check.integration_id === appId,
              ),
          );
          if (byRule) return okAsync<boolean, GithubCallError>(true);
          return github
            .json<RestBranch>(repo, 'GET', `/repos/${repo}/branches/${ref}`)
            .orElse((e) => none<RestBranch>(e))
            .map((info) =>
              (info?.protection?.required_status_checks?.checks ?? []).some(
                (check) => check.context === checkName && check.app_id === appId,
              ),
            );
        });
    },
  };
}
