/**
 * Links a page of issues to the branches and pull requests that work on them,
 * for the Issues panel badges.
 *
 * A PR is linked to an issue when GitHub records it as closing the issue
 * (`closes`, from the PR's `closingIssuesReferences`: closing keywords in the
 * description or a manual link), when its title closes it (`Fixes #42`,
 * `closes owner/repo#42`), or when its head branch carries the issue number
 * (`issue-42-fix-bug`). The branch need not exist locally.
 */

import type { EnrichedGitHubIssue, GitHubIssue } from '@funny/shared';

type LinkedPR = NonNullable<EnrichedGitHubIssue['linkedPR']>;

/**
 * The few PR fields the linker reads. Kept lean on purpose: fetching full REST
 * PR objects (bodies, users, repos) for 200 PRs cost seconds and megabytes.
 */
export interface LinkablePR {
  number: number;
  url: string;
  title: string;
  state: 'open' | 'closed';
  merged: boolean;
  headRef: string;
  /** Issue numbers in this repository that GitHub says the PR closes. */
  closes: number[];
}

/** The issue number in a branch like `issue-42-fix-bug`, `42-fix`, `fix/42-thing`. */
export function issueNumberInBranch(branch: string): number | null {
  const match = branch.match(/(?:^|[/-])(\d+)(?:[/-]|$)/);
  return match ? Number.parseInt(match[1], 10) : null;
}

const CLOSING_REFERENCE =
  /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+(?:[\w.-]+\/[\w.-]+)?#(\d+)\b/gi;

/** Issue numbers a PR closes through GitHub's keywords. */
export function closingReferences(text: string | null | undefined, repo?: string): number[] {
  if (!text) return [];
  const numbers: number[] = [];
  for (const match of text.matchAll(CLOSING_REFERENCE)) {
    // `owner/repo#N` for another repository is not this repo's issue.
    const qualified = match[0].match(/([\w.-]+\/[\w.-]+)#\d+$/);
    if (qualified && repo && qualified[1].toLowerCase() !== repo.toLowerCase()) continue;
    numbers.push(Number.parseInt(match[1], 10));
  }
  return numbers;
}

function prState(pr: LinkablePR): string {
  if (pr.merged) return 'merged';
  return pr.state;
}

/** Open first, then merged, then closed; newer before older within each. */
function rank(pr: LinkablePR): number {
  if (pr.state === 'open') return 0;
  return pr.merged ? 1 : 2;
}

export function linkIssues(
  issues: GitHubIssue[],
  options: {
    /** Local branch names. */
    branches: string[];
    pullRequests: LinkablePR[];
    /** `owner/repo`, so a cross-repo `Fixes other/repo#N` is ignored. */
    repo?: string;
    suggestBranchName: (issue: GitHubIssue) => string;
  },
): EnrichedGitHubIssue[] {
  const branchByIssue = new Map<number, string>();
  for (const branch of options.branches) {
    const number = issueNumberInBranch(branch);
    if (number !== null && !branchByIssue.has(number)) branchByIssue.set(number, branch);
  }

  const sorted = [...options.pullRequests].sort((a, b) => rank(a) - rank(b) || b.number - a.number);
  const prByIssue = new Map<number, LinkablePR>();
  for (const pr of sorted) {
    const numbers = new Set([...pr.closes, ...closingReferences(pr.title, options.repo)]);
    const fromBranch = issueNumberInBranch(pr.headRef);
    if (fromBranch !== null) numbers.add(fromBranch);
    for (const number of numbers) {
      if (!prByIssue.has(number)) prByIssue.set(number, pr);
    }
  }

  return issues.map((issue) => {
    const pr = prByIssue.get(issue.number);
    const linkedPR: LinkedPR | null = pr
      ? { number: pr.number, url: pr.url, state: prState(pr) }
      : null;
    return {
      ...issue,
      // An open PR's branch counts as the issue's branch even if it is not
      // local; a closed one does not, so a new thread can still be started.
      linkedBranch: branchByIssue.get(issue.number) ?? (pr?.state === 'open' ? pr.headRef : null),
      linkedPR,
      suggestedBranchName: options.suggestBranchName(issue),
    };
  });
}
