type HistoryEntry = { hash: string; parentHashes: readonly string[] };

/** The marked commits another marked commit builds on: none of them is a run's newest. */
function markedWithMarkedChild(
  entries: readonly HistoryEntry[],
  marked: ReadonlySet<string>,
): Set<string> {
  const hasMarkedChild = new Set<string>();
  for (const entry of entries) {
    if (!marked.has(entry.hash)) continue;
    for (const parent of entry.parentHashes) if (marked.has(parent)) hasMarkedChild.add(parent);
  }
  return hasMarkedChild;
}

/** How many marked commits `newest` reaches through marked parents, itself included. */
function runSize(
  newest: string,
  parentsByHash: ReadonlyMap<string, readonly string[]>,
  marked: ReadonlySet<string>,
): number {
  const seen = new Set<string>([newest]);
  const stack = [newest];
  for (let hash = stack.pop(); hash !== undefined; hash = stack.pop()) {
    const next = (parentsByHash.get(hash) ?? []).filter((p) => marked.has(p) && !seen.has(p));
    for (const parent of next) seen.add(parent);
    stack.push(...next);
  }
  return seen.size;
}

/**
 * Commits not pushed (or not pulled) come in runs along the history: a branch
 * with 16 local commits is one run of 16. The History graph shows the run's
 * size once, on its newest commit (the same count the sidebar shows beside a
 * thread), and only the arrow on the older commits of the run.
 */
export function syncRunCounts(
  entries: readonly HistoryEntry[],
  marked: ReadonlySet<string>,
): Map<string, number> {
  const parentsByHash = new Map(entries.map((e) => [e.hash, e.parentHashes]));
  const hasMarkedChild = markedWithMarkedChild(entries, marked);
  const newest = entries.filter((e) => marked.has(e.hash) && !hasMarkedChild.has(e.hash));
  return new Map(newest.map((e) => [e.hash, runSize(e.hash, parentsByHash, marked)]));
}
