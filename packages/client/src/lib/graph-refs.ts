import type { GraphRefDTO } from './api/git';

/**
 * A commit's branch/tag decorations, folded for display in the commit graph.
 *
 * GitKraken-style: when a local branch and its remote-tracking branch
 * (`feat/x` + `origin/feat/x`) decorate the SAME commit they're in sync, so the
 * pair collapses into ONE local entry carrying {@link FoldedRef.syncedRemote}
 * (rendered with a "synced" cloud adornment) instead of two near-identical
 * chips. A remote-tracking branch with no local counterpart on this commit (the
 * local branch is ahead, on a newer commit) stays its own `remote` entry so it
 * reads unmistakably as "the remote", not a second local branch.
 */
export type FoldedRefKind = 'local' | 'remote' | 'tag';

export interface FoldedRef {
  kind: FoldedRefKind;
  /** Display label: `main`, `origin/main`, a tag name, or `HEAD` (detached). */
  name: string;
  /** True only for the checked-out branch (local refs only). */
  isCurrent: boolean;
  /**
   * For a local branch in sync with its remote on this same commit: the
   * remote-tracking ref's name (e.g. `origin/main`). Undefined otherwise.
   */
  syncedRemote?: string;
  /** Pull request associated with this branch ref, when known. */
  pullRequest?: GraphRefDTO['pullRequest'];
}

interface GraphReachabilityEntry {
  hash: string;
  parentHashes: string[];
  refs: readonly GraphRefDTO[];
}

interface GraphNodeParentRefEntry {
  hash: string;
  shortHash?: string;
  refs: readonly RawGraphRef[];
  headBranch: string | null;
  parentHashes?: readonly string[];
}

interface GraphNodeParentRefLink {
  sourceHash: string;
  sourceShortHash?: string;
  targetHash: string;
  event?: {
    branch: string | null;
    onto: string | null;
  };
}

/** Branch portion of a remote ref — remote names never contain `/`. */
const remoteBranchOf = (name: string) => name.slice(name.indexOf('/') + 1);

/**
 * A ref as it may arrive over the wire. Current runners send a classified
 * {@link GraphRefDTO}; an older runner (server and runner deploy on independent
 * cycles) may still send a bare string. We tolerate both so a lagging runner
 * degrades to plain named chips instead of blank ones.
 */
export type RawGraphRef = string | GraphRefDTO;

/**
 * Coerce a wire ref to a classified {@link GraphRefDTO}. Objects (current
 * runners) pass through with the authoritative server-side `kind`. A legacy
 * bare string (older runner) is classified best-effort: a version-ish name with
 * no `/` is a tag; a slashed name whose branch portion is *also* a ref on this
 * commit is its remote-tracking branch (`origin/master` alongside `master`);
 * everything else is local. `allNames` is the full set of ref names on the
 * commit, needed for that remote heuristic.
 */
function normalizeRef(r: RawGraphRef, allNames: Set<string>): GraphRefDTO {
  if (typeof r !== 'string') return r;
  if (!r.includes('/')) return { name: r, kind: /^v?\d/.test(r) ? 'tag' : 'local' };
  // Slashed name: remote-tracking iff its branch portion is a sibling ref here.
  // A genuinely slashed *local* branch (`feat/x`, no sibling `x`) stays local.
  const isRemote = allNames.has(remoteBranchOf(r));
  return { name: r, kind: isRemote ? 'remote' : 'local' };
}

/**
 * Fold a commit's refs into display entries, collapsing each local+remote
 * in-sync pair into a single local entry. Ref order is preserved (minus the
 * folded-away remotes). Folding works whether refs arrive classified (current
 * runners) or as legacy bare strings (older runners) — the pairing is by name.
 * Pure — safe to memoize on `(refs, headBranch)`.
 */
export function foldGraphRefs(
  rawRefs: readonly RawGraphRef[],
  headBranch: string | null,
): FoldedRef[] {
  // Drop empty/whitespace ref names defensively — they'd render as a blank chip.
  const named = rawRefs.filter((r) => (typeof r === 'string' ? r : r.name).trim() !== '');
  const allNames = new Set(named.map((r) => (typeof r === 'string' ? r : r.name)));
  const refs = named.map((r) => normalizeRef(r, allNames));
  const localNames = new Set(refs.filter((r) => r.kind === 'local').map((r) => r.name));
  // local branch name → its remote-tracking ref sitting on this same commit.
  const syncedRemoteFor = new Map<string, GraphRefDTO>();
  for (const r of refs) {
    if (r.kind !== 'remote') continue;
    const branch = remoteBranchOf(r.name);
    if (localNames.has(branch) && !syncedRemoteFor.has(branch)) syncedRemoteFor.set(branch, r);
  }

  const out: FoldedRef[] = [];
  for (const r of refs) {
    // Drop a remote that's been folded into its local chip.
    if (r.kind === 'remote' && syncedRemoteFor.get(remoteBranchOf(r.name)) === r) continue;
    if (r.kind === 'tag') {
      out.push({ kind: 'tag', name: r.name, isCurrent: false });
    } else if (r.kind === 'remote') {
      const folded: FoldedRef = { kind: 'remote', name: r.name, isCurrent: false };
      if (r.pullRequest) folded.pullRequest = r.pullRequest;
      out.push(folded);
    } else {
      const syncedRemote = syncedRemoteFor.get(r.name);
      const folded: FoldedRef = {
        kind: 'local',
        name: r.name,
        isCurrent: !!headBranch && r.name === headBranch,
        syncedRemote: syncedRemote?.name,
      };
      const pullRequest = r.pullRequest ?? syncedRemote?.pullRequest;
      if (pullRequest) folded.pullRequest = pullRequest;
      out.push(folded);
    }
  }
  return out;
}

export function graphNodeRefLabel(foldedRefs: readonly FoldedRef[]): string | null {
  const labels = graphNodeRefLabels(foldedRefs);
  return labels.length > 0 ? labels.join(', ') : null;
}

function graphNodeRefLabels(foldedRefs: readonly FoldedRef[]): string[] {
  const localRefs: string[] = [];
  const remoteRefs: string[] = [];

  for (const ref of foldedRefs) {
    if (ref.kind === 'local' && ref.name !== 'HEAD') localRefs.push(ref.name);
    else if (ref.kind === 'remote') remoteRefs.push(ref.name);
  }

  if (localRefs.length > 0) return localRefs;
  if (remoteRefs.length > 0) return remoteRefs;
  return [];
}

function graphNodeBranchIdentities(foldedRefs: readonly FoldedRef[]): Set<string> {
  const identities = new Set<string>();
  for (const ref of foldedRefs) {
    if (ref.kind === 'local' && ref.name !== 'HEAD') {
      identities.add(ref.name);
      if (ref.syncedRemote) identities.add(remoteBranchOf(ref.syncedRemote));
    } else if (ref.kind === 'remote') {
      identities.add(remoteBranchOf(ref.name));
    }
  }
  return identities;
}

function hasSharedIdentity(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  for (const value of a) {
    if (b.has(value)) return true;
  }
  return false;
}

function addUnique(map: Map<string, string[]>, hash: string, label: string) {
  const existing = map.get(hash);
  if (existing) {
    if (!existing.includes(label)) existing.push(label);
  } else {
    map.set(hash, [label]);
  }
}

function graphNodeBranchContextLabels(
  entries: readonly GraphNodeParentRefEntry[],
): Map<string, string[]> {
  const entriesByHash = new Map(entries.map((entry) => [entry.hash, entry]));
  const labelsByHash = new Map<string, string[]>();

  for (const entry of entries) {
    const labels = graphNodeRefLabels(foldGraphRefs(entry.refs, entry.headBranch));
    if (labels.length === 0) continue;

    const stack = [entry.hash];
    const seen = new Set<string>();
    while (stack.length > 0) {
      const hash = stack.pop()!;
      if (seen.has(hash)) continue;
      seen.add(hash);
      for (const label of labels) addUnique(labelsByHash, hash, label);

      const current = entriesByHash.get(hash);
      if (!current) continue;
      for (const parentHash of current.parentHashes ?? []) {
        if (entriesByHash.has(parentHash)) stack.push(parentHash);
      }
    }
  }

  return labelsByHash;
}

export function graphNodeForkedFromRefLabels(
  entries: readonly GraphNodeParentRefEntry[],
): Map<string, string> {
  const entriesByHash = new Map(entries.map((entry) => [entry.hash, entry]));
  const labels = new Map<string, string>();

  for (const entry of entries) {
    const ownIdentities = graphNodeBranchIdentities(foldGraphRefs(entry.refs, entry.headBranch));
    const queue = [...(entry.parentHashes ?? [])];
    const seen = new Set<string>();

    while (queue.length > 0) {
      const parentHash = queue.shift()!;
      if (seen.has(parentHash)) continue;
      seen.add(parentHash);

      const parent = entriesByHash.get(parentHash);
      if (!parent) continue;

      const parentRefs = foldGraphRefs(parent.refs, parent.headBranch);
      const parentLabel = graphNodeRefLabel(parentRefs);
      if (parentLabel) {
        const parentIdentities = graphNodeBranchIdentities(parentRefs);
        if (!hasSharedIdentity(ownIdentities, parentIdentities)) {
          labels.set(entry.hash, parentLabel);
          break;
        }
      }

      queue.push(...(parent.parentHashes ?? []));
    }
  }

  return labels;
}

export interface GraphNodeParentLabel {
  commit: string;
  branchLabels: string[];
}

export function graphNodeParentLabels(
  entries: readonly GraphNodeParentRefEntry[],
): Map<string, GraphNodeParentLabel> {
  const entriesByHash = new Map(entries.map((entry) => [entry.hash, entry]));
  const branchContextByHash = graphNodeBranchContextLabels(entries);
  const labels = new Map<string, GraphNodeParentLabel>();

  for (const entry of entries) {
    const parentHash = entry.parentHashes?.[0];
    if (!parentHash) continue;

    const parent = entriesByHash.get(parentHash);
    if (!parent) {
      labels.set(entry.hash, { commit: parentHash.slice(0, 7), branchLabels: [] });
      continue;
    }

    const parentShortHash = parent.shortHash ?? parent.hash.slice(0, 7);
    const parentRefLabels = graphNodeRefLabels(foldGraphRefs(parent.refs, parent.headBranch));
    const parentBranchLabels =
      parentRefLabels.length > 0 ? parentRefLabels : (branchContextByHash.get(parent.hash) ?? []);
    labels.set(entry.hash, { commit: parentShortHash, branchLabels: parentBranchLabels });
  }

  return labels;
}

export function graphNodeParentRefLabels(
  links: readonly GraphNodeParentRefLink[],
  entries: readonly GraphNodeParentRefEntry[],
): Map<string, string> {
  const entriesByHash = new Map(entries.map((entry) => [entry.hash, entry]));
  const labelsByTargetHash = new Map<string, string[]>();

  for (const link of links) {
    const sourceEntry = entriesByHash.get(link.sourceHash);
    const sourceRefLabel = sourceEntry
      ? graphNodeRefLabel(foldGraphRefs(sourceEntry.refs, sourceEntry.headBranch))
      : null;
    const label =
      sourceRefLabel ??
      link.event?.branch ??
      link.event?.onto ??
      link.sourceShortHash ??
      link.sourceHash.slice(0, 7);
    if (!label) continue;

    addUnique(labelsByTargetHash, link.targetHash, label);
  }

  return new Map(
    Array.from(labelsByTargetHash, ([targetHash, labels]) => [targetHash, labels.join(', ')]),
  );
}

export function inferUnpulledHashesFromGraphEntries(
  entries: readonly GraphReachabilityEntry[],
): Set<string> {
  const byHash = new Map(entries.map((entry) => [entry.hash, entry]));
  const remoteTips = new Set<string>();
  const localTips = new Set<string>();

  for (const entry of entries) {
    for (const ref of entry.refs) {
      if (ref.kind === 'remote') remoteTips.add(entry.hash);
      if (ref.kind === 'local' && ref.name !== 'HEAD') localTips.add(entry.hash);
    }
  }

  const reachableFrom = (tips: Set<string>) => {
    const seen = new Set<string>();
    const stack = [...tips];
    while (stack.length > 0) {
      const hash = stack.pop()!;
      if (seen.has(hash)) continue;
      seen.add(hash);
      const entry = byHash.get(hash);
      if (!entry) continue;
      for (const parent of entry.parentHashes) {
        if (byHash.has(parent)) stack.push(parent);
      }
    }
    return seen;
  };

  const remoteReachable = reachableFrom(remoteTips);
  const localReachable = reachableFrom(localTips);
  const inferred = new Set<string>();
  for (const hash of remoteReachable) {
    if (!localReachable.has(hash)) inferred.add(hash);
  }
  return inferred;
}
