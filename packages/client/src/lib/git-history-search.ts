/**
 * Pure filter predicate for the History (commit graph) search bar.
 *
 * The search is a list FILTER (not a Ctrl+F highlight): a commit is kept when the
 * query matches any information the commit carries —
 *   - its full or short SHA (`hash` / `shortHash`),
 *   - its subject / title (`message`),
 *   - its body / description (`body`), or
 *   - any branch / tag ref decorating it (`refs[].name`).
 *
 * So typing a branch name surfaces the commit that branch points at, and typing
 * words from a message surfaces that commit, in one box. Matching is a
 * case-insensitive substring test. A blank query matches everything (no filter).
 *
 * Kept free of React/DOM so it can be unit-tested directly.
 */

import { includesSearchText } from '@funny/shared/lib/text-search';

/** The minimal commit shape the filter needs. */
export interface SearchableCommit {
  /** Full commit SHA. */
  hash?: string;
  /** Short commit SHA. */
  shortHash?: string;
  /** Commit subject / title. */
  message: string;
  author?: string;
  authorEmail?: string;
  /** Commit body / description (optional — empty when none). */
  body?: string;
  /** Branch / tag refs decorating this commit. */
  refs?: { name: string }[];
}

/** True when `commit` should be shown for `query` (blank query → always true). */
export function commitMatchesQuery(commit: SearchableCommit, query: string): boolean {
  const q = query.trim();
  if (!q) return true;
  if (commit.hash && includesSearchText(commit.hash, q)) return true;
  if (commit.shortHash && includesSearchText(commit.shortHash, q)) return true;
  if (includesSearchText(commit.message, q)) return true;
  if (commit.body && includesSearchText(commit.body, q)) return true;
  if (commit.refs?.some((r) => includesSearchText(r.name, q))) return true;
  return false;
}

export type CommitSyncFilter = 'all' | 'pull' | 'push';

/** Sync status and text search are combined; pull uses the same markers as the graph. */
export function commitMatchesFilters(
  commit: SearchableCommit & { hash: string },
  query: string,
  syncFilter: CommitSyncFilter,
  unpushed: ReadonlySet<string>,
  unpulled: ReadonlySet<string>,
  inferredUnpulled: ReadonlySet<string>,
  authors: readonly string[] = [],
): boolean {
  if (authors.length > 0 && !authors.includes(commitAuthorIdentity(commit))) return false;
  if (syncFilter === 'push' && !unpushed.has(commit.hash)) return false;
  if (syncFilter === 'pull' && !unpulled.has(commit.hash) && !inferredUnpulled.has(commit.hash)) {
    return false;
  }
  return commitMatchesQuery(commit, query);
}

/** Email distinguishes namesakes; name is the fallback for commits without email. */
export function commitAuthorIdentity(
  commit: Pick<SearchableCommit, 'author' | 'authorEmail'>,
): string {
  return commit.authorEmail?.trim().toLowerCase() || commit.author?.trim() || '';
}

export function collectCommitAuthors(
  commits: SearchableCommit[],
): { value: string; label: string }[] {
  const authors = new Map<string, { value: string; label: string }>();
  for (const commit of commits) {
    const value = commitAuthorIdentity(commit);
    if (!value || authors.has(value)) continue;
    const name = commit.author?.trim();
    const email = commit.authorEmail?.trim();
    authors.set(value, {
      value,
      label: name && email ? `${name} <${email}>` : name || email || value,
    });
  }
  return [...authors.values()].sort((a, b) => a.label.localeCompare(b.label));
}
