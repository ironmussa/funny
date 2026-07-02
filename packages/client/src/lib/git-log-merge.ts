export interface HashIdentifiedEntry {
  hash: string;
}

export function uniqueLogEntriesByHash<T extends HashIdentifiedEntry>(entries: T[]): T[] {
  const seen = new Set<string>();
  const unique: T[] = [];

  for (const entry of entries) {
    if (seen.has(entry.hash)) continue;
    seen.add(entry.hash);
    unique.push(entry);
  }

  return unique;
}

export function mergeLogEntriesByHash<T extends HashIdentifiedEntry>(current: T[], next: T[]): T[] {
  if (current.length === 0) return uniqueLogEntriesByHash(next);
  if (next.length === 0) return current;

  const seen = new Set(current.map((entry) => entry.hash));
  const merged = [...current];

  for (const entry of next) {
    if (seen.has(entry.hash)) continue;
    seen.add(entry.hash);
    merged.push(entry);
  }

  return merged;
}
