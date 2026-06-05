import type { EnrichedGitHubIssue } from '@funny/shared';

/** Prompt prefill when starting a thread from a GitHub issue (body is shown in the list, not duplicated here). */
export function buildIssueThreadPrompt(
  issue: Pick<EnrichedGitHubIssue, 'number' | 'title' | 'labels'>,
  repo: { owner: string; repo: string },
): string {
  const lines = [
    `Fix GitHub issue #${issue.number}: ${issue.title}`,
    `URL: https://github.com/${repo.owner}/${repo.repo}/issues/${issue.number}`,
  ];
  if (issue.labels.length > 0) {
    lines.push('', `Labels: ${issue.labels.map((l) => l.name).join(', ')}`);
  }
  return lines.join('\n');
}
