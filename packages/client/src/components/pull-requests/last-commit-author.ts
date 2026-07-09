import type { PRCommit } from '@funny/shared';

interface PRWithLastCommit {
  last_commit?: PRCommit | null;
}

export function getLastCommitAuthor(
  pr: PRWithLastCommit,
): { name: string; avatarUrl?: string } | null {
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
