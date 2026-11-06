import type { GitRebaseReflogEventDTO } from '@/lib/api/git';

interface RebaseGraphEntry {
  hash: string;
  shortHash?: string;
  authorEmail?: string;
  authoredAt?: number;
  committedAt?: string;
  message?: string;
  parentHashes?: string[];
}

export interface RebaseCopyLink {
  /** The reflog rebase that produced the copy; null when inferred from commit identity. */
  event: GitRebaseReflogEventDTO | null;
  sourceHash: string;
  sourceShortHash: string;
  targetHash: string;
  targetShortHash: string;
  subject: string;
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
      if (!visibleHashes.has(pair.originalHash) || !visibleHashes.has(pair.rebasedHash)) continue;
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
      });
    }
  }

  const linkedTargets = new Set(links.map((link) => link.targetHash));
  for (const link of inferCopiedCommitLinks(entries)) {
    if (linkedTargets.has(link.targetHash)) continue;
    linkedTargets.add(link.targetHash);
    links.push(link);
  }
  return links;
}

/**
 * Pair copies that left no rebase in the reflog: cherry-picks, ports, rebases
 * done in another clone or expired from the reflog. Git keeps the author, the
 * author date and the subject when it replays a commit, so commits that share
 * all three are copies of one another. The earliest committed one is the
 * original; every later one links back to it.
 */
function inferCopiedCommitLinks(entries: RebaseGraphEntry[]): RebaseCopyLink[] {
  const groups = new Map<string, RebaseGraphEntry[]>();
  for (const entry of entries) {
    const key = copyIdentityKey(entry);
    if (key === null) continue;
    const group = groups.get(key);
    if (group) group.push(entry);
    else groups.set(key, [entry]);
  }
  return [...groups.values()].flatMap(copyLinksForGroup);
}

/** Author, author date and subject; null for merges and entries missing any of them. */
function copyIdentityKey(entry: RebaseGraphEntry): string | null {
  const { authorEmail, authoredAt, message } = entry;
  if (!authorEmail || !authoredAt || !message) return null;
  if ((entry.parentHashes?.length ?? 0) > 1) return null;
  return `${authorEmail}\x1f${authoredAt}\x1f${message.trim()}`;
}

function copyLinksForGroup(group: RebaseGraphEntry[]): RebaseCopyLink[] {
  if (group.length < 2) return [];
  const [original, ...copies] = group.toSorted(
    (a, b) => Date.parse(a.committedAt ?? '') - Date.parse(b.committedAt ?? ''),
  );
  return copies.map((copy) => ({
    event: null,
    sourceHash: original.hash,
    sourceShortHash: shortHashOf(original),
    targetHash: copy.hash,
    targetShortHash: shortHashOf(copy),
    subject: copy.message?.trim() ?? '',
  }));
}

function shortHashOf(entry: RebaseGraphEntry): string {
  return entry.shortHash ?? entry.hash.slice(0, 7);
}
