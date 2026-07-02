import type { GitHubPR } from '@funny/shared';

export function getLastCommitAuthor(pr: GitHubPR): { name: string; avatarUrl?: string } | null {
  const commit = pr.last_commit;
  if (!commit) return null;
  if (commit.author?.login) {
    return {
      name: commit.author.login,
      avatarUrl: commit.author.avatar_url,
    };
  }
  if (commit.author_name) return { name: commit.author_name };
  return null;
}
