/**
 * Pure filter predicate for the History (commit graph) search bar.
 *
 * The search is a list FILTER (not a Ctrl+F highlight): a commit is kept when the
 * query matches any information the commit carries —
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

/** The minimal commit shape the filter needs. */
export interface SearchableCommit {
  /** Commit subject / title. */
  message: string;
  /** Commit body / description (optional — empty when none). */
  body?: string;
  /** Branch / tag refs decorating this commit. */
  refs?: { name: string }[];
}

/** True when `commit` should be shown for `query` (blank query → always true). */
export function commitMatchesQuery(commit: SearchableCommit, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (commit.message.toLowerCase().includes(q)) return true;
  if (commit.body && commit.body.toLowerCase().includes(q)) return true;
  if (commit.refs?.some((r) => r.name.toLowerCase().includes(q))) return true;
  return false;
}
