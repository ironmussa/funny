/**
 * GitHub check runs and branch protection queries for the regression proof gate.
 *
 * - Creating a check run on a commit (requires `checks: write` on the token).
 * - Querying whether a named check is required on a branch, and from which App.
 * - Querying whether a branch has commits ahead of the default branch.
 * - Merging a pull request at an exact SHA, never enabling auto-merge.
 */

import { errAsync, okAsync, ResultAsync } from 'neverthrow';

import type { MergeMethod } from './pull-requests.js';
import type { GithubCallError, RepoGithub } from './repo-github.js';

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
  | { kind: 'not-mergeable'; reason: string };

export interface RequiredCheckInfo {
  required: boolean;
  fromAppId?: number;
}

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

  isCheckRequiredOnBranch(
    repo: string,
    branch: string,
    checkName: string,
    appId?: number,
  ): ResultAsync<RequiredCheckInfo, GithubCallError>;
}

interface RestBranchProtection {
  required_status_checks?: {
    contexts?: string[];
    checks?: Array<{ context: string; app_id?: number | null }>;
  } | null;
}

interface RestRuleset {
  id: number;
  enforcement: string;
  rules?: Array<{
    type: string;
    parameters?: {
      required_status_checks?: Array<{
        context: string;
        integration_id?: number | null;
      }>;
    } | null;
  }>;
  conditions?: {
    ref_name?: {
      include?: string[];
    };
  };
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

    isCheckRequiredOnBranch(repo, branch, checkName, appId) {
      return checkFromRulesets(github, repo, branch, checkName, appId).andThen((rulesetResult) => {
        if (rulesetResult.required) return okAsync(rulesetResult);
        return checkFromClassicProtection(github, repo, branch, checkName, appId);
      });
    },
  };
}

function checkFromRulesets(
  github: RepoGithub,
  repo: string,
  branch: string,
  checkName: string,
  appId?: number,
): ResultAsync<RequiredCheckInfo, GithubCallError> {
  return github
    .json<RestRuleset[]>(repo, 'GET', `/repos/${repo}/rulesets?per_page=100`)
    .andThen((rulesets) => {
      for (const ruleset of rulesets) {
        if (ruleset.enforcement !== 'active') continue;
        const matchesBranch = rulesetMatchesBranch(ruleset, branch);
        if (!matchesBranch) continue;

        for (const rule of ruleset.rules ?? []) {
          if (rule.type !== 'required_status_checks') continue;
          const checks = rule.parameters?.required_status_checks ?? [];
          for (const check of checks) {
            if (check.context !== checkName) continue;
            const fromApp = check.integration_id ?? undefined;
            if (appId !== undefined && fromApp !== undefined && fromApp === appId) {
              return okAsync<RequiredCheckInfo, GithubCallError>({
                required: true,
                fromAppId: fromApp,
              });
            }
            if (appId === undefined) {
              return okAsync<RequiredCheckInfo, GithubCallError>({
                required: true,
                fromAppId: fromApp,
              });
            }
            return okAsync<RequiredCheckInfo, GithubCallError>({
              required: true,
              fromAppId: fromApp,
            });
          }
        }
      }
      return okAsync<RequiredCheckInfo, GithubCallError>({ required: false });
    })
    .orElse((e) =>
      e.status === 404
        ? okAsync<RequiredCheckInfo, GithubCallError>({ required: false })
        : errAsync(e),
    );
}

function rulesetMatchesBranch(ruleset: RestRuleset, branch: string): boolean {
  const includes = ruleset.conditions?.ref_name?.include ?? [];
  if (includes.length === 0) return true;
  for (const pattern of includes) {
    if (pattern === `refs/heads/${branch}`) return true;
    if (pattern === `~DEFAULT_BRANCH`) return true;
    const glob = pattern.replace('refs/heads/', '');
    if (simpleGlobMatch(glob, branch)) return true;
  }
  return false;
}

function simpleGlobMatch(pattern: string, value: string): boolean {
  if (pattern === '*' || pattern === '**') return true;
  if (!pattern.includes('*')) return pattern === value;
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`).test(value);
}

function checkFromClassicProtection(
  github: RepoGithub,
  repo: string,
  branch: string,
  checkName: string,
  appId?: number,
): ResultAsync<RequiredCheckInfo, GithubCallError> {
  return github
    .json<RestBranchProtection>(
      repo,
      'GET',
      `/repos/${repo}/branches/${encodeURIComponent(branch)}/protection`,
    )
    .andThen((protection) => {
      const checks = protection.required_status_checks?.checks ?? [];
      const contexts = protection.required_status_checks?.contexts ?? [];

      for (const check of checks) {
        if (check.context !== checkName) continue;
        const fromApp = check.app_id ?? undefined;
        return okAsync<RequiredCheckInfo, GithubCallError>({
          required: true,
          fromAppId: fromApp,
        });
      }

      if (contexts.includes(checkName)) {
        return okAsync<RequiredCheckInfo, GithubCallError>({
          required: true,
        });
      }

      return okAsync<RequiredCheckInfo, GithubCallError>({ required: false });
    })
    .orElse((e) =>
      e.status === 404
        ? okAsync<RequiredCheckInfo, GithubCallError>({ required: false })
        : errAsync(e),
    );
}
