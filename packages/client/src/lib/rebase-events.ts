import type { GitRebaseReflogEventDTO } from '@/lib/api/git';

interface RebaseGraphEntry {
  hash: string;
}

export interface RebaseCopyLink {
  event: GitRebaseReflogEventDTO;
  sourceHash: string;
  sourceShortHash: string;
  targetHash: string;
  targetShortHash: string;
  subject: string;
  sourceVisible: boolean;
}

export function rebaseEventScopeLabel(event: Pick<GitRebaseReflogEventDTO, 'branch' | 'onto'>) {
  if (event.branch && event.onto) return `${event.branch} -> ${event.onto}`;
  if (event.branch) return event.branch;
  if (event.onto) return `onto ${event.onto}`;
  return null;
}

export function indexRebaseEventsByHash(events: GitRebaseReflogEventDTO[]) {
  const byHash = new Map<string, GitRebaseReflogEventDTO[]>();
  for (const event of events) {
    const hashes = new Set(event.commitHashes);
    if (event.startHash) hashes.add(event.startHash);
    if (event.finishHash) hashes.add(event.finishHash);
    for (const pair of event.commitPairs ?? []) {
      hashes.add(pair.originalHash);
      hashes.add(pair.rebasedHash);
    }
    for (const hash of hashes) {
      const existing = byHash.get(hash);
      if (existing) existing.push(event);
      else byHash.set(hash, [event]);
    }
  }
  return byHash;
}

export function inferRebaseCopyLinks(
  events: GitRebaseReflogEventDTO[],
  entries: RebaseGraphEntry[],
): RebaseCopyLink[] {
  const visibleHashes = new Set(entries.map((entry) => entry.hash));

  const links: RebaseCopyLink[] = [];
  const seen = new Set<string>();
  for (const event of events) {
    for (const pair of event.commitPairs ?? []) {
      if (!visibleHashes.has(pair.rebasedHash)) continue;
      const key = `${event.id}:${pair.originalHash}->${pair.rebasedHash}`;
      if (seen.has(key)) continue;
      seen.add(key);
      links.push({
        event,
        sourceHash: pair.originalHash,
        sourceShortHash: pair.originalShortHash,
        targetHash: pair.rebasedHash,
        targetShortHash: pair.rebasedShortHash,
        subject: pair.subject,
        sourceVisible: visibleHashes.has(pair.originalHash),
      });
    }
  }
  return links;
}
