import type { GitRebaseCommitPair, GitRebaseReflogEvent } from './log.js';

/**
 * Commit pairs of the rebase events, as computed for one repository.
 * `complete` is false when a git step failed and the pairs may be missing some.
 */
export interface RebasePairsComputation {
  pairsByEvent: GitRebaseCommitPair[][];
  complete: boolean;
}

interface CacheEntry {
  signature: string;
  pending: Promise<RebasePairsComputation>;
}

/** Repositories remembered at once; the oldest is dropped past this. */
const MAX_REPOSITORIES = 64;

const cache = new Map<string, CacheEntry>();

/**
 * Identity of the rebase events: every step's action, resulting commit and
 * message, in order. That is all the pairs are computed from, so the same
 * steps always give the same pairs.
 */
function eventsSignature(events: GitRebaseReflogEvent[], candidateLimit: number): string {
  const steps = events.map((event) =>
    event.steps.map((step) => `${step.action}\x1f${step.hash}\x1f${step.message}`).join('\x1e'),
  );
  return `${candidateLimit}\x1d${steps.join('\x1d')}`;
}

/**
 * Return the commit pairs of `events`, computing them only when the rebase
 * events of `cwd` changed since the last call. Computing them takes a
 * `git log --all --reflog`, a `git show --patch` and a `git patch-id`, while
 * the pairs of a rebase never change once it is in the reflog. A commit or a
 * checkout adds reflog entries but no rebase steps, so it keeps the cached
 * pairs. Concurrent calls for the same events share one computation, and an
 * incomplete computation (a git step failed) is not kept.
 */
export async function cachedRebasePairs(
  cwd: string,
  events: GitRebaseReflogEvent[],
  candidateLimit: number,
  compute: () => Promise<RebasePairsComputation>,
): Promise<GitRebaseCommitPair[][]> {
  const signature = eventsSignature(events, candidateLimit);
  const cached = cache.get(cwd);
  if (cached?.signature === signature) {
    // Refresh the entry's position so the least recently used repo is dropped first.
    cache.delete(cwd);
    cache.set(cwd, cached);
    return (await cached.pending).pairsByEvent;
  }

  const entry: CacheEntry = { signature, pending: compute() };
  cache.delete(cwd);
  cache.set(cwd, entry);
  if (cache.size > MAX_REPOSITORIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }

  const forget = () => {
    if (cache.get(cwd) === entry) cache.delete(cwd);
  };
  try {
    const computed = await entry.pending;
    if (!computed.complete) forget();
    return computed.pairsByEvent;
  } catch (error) {
    forget();
    throw error;
  }
}

/** Drop every cached computation. For tests. */
export function clearRebasePairsCache(): void {
  cache.clear();
}
