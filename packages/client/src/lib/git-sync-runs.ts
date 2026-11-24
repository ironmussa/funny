/**
 * Commits not pushed (or not pulled) come in runs along the history: a branch
 * with 16 local commits is one run of 16. The History graph shows the run's
 * size once, on its newest commit (the same count the sidebar shows beside a
 * thread), and only the arrow on the older commits of the run.
 */
export function syncRunCounts(
  entries: readonly { hash: string; parentHashes: readonly string[] }[],
  marked: ReadonlySet<string>,
): Map<string, number> {
  const parentsByHash = new Map(entries.map((e) => [e.hash, e.parentHashes]));
  // A marked commit that another marked commit builds on is not the run's newest.
  const hasMarkedChild = new Set<string>();
  for (const entry of entries) {
    if (!marked.has(entry.hash)) continue;
    for (const parent of entry.parentHashes) if (marked.has(parent)) hasMarkedChild.add(parent);
  }
  const counts = new Map<string, number>();
  for (const entry of entries) {
    if (!marked.has(entry.hash) || hasMarkedChild.has(entry.hash)) continue;
    // Every marked commit the newest one reaches through marked parents.
    const seen = new Set<string>([entry.hash]);
    const stack = [entry.hash];
    while (stack.length > 0) {
      for (const parent of parentsByHash.get(stack.pop()!) ?? []) {
        if (marked.has(parent) && !seen.has(parent)) {
          seen.add(parent);
          stack.push(parent);
        }
      }
    }
    counts.set(entry.hash, seen.size);
  }
  return counts;
}
