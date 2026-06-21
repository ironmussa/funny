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
}

interface GraphReachabilityEntry {
  hash: string;
  parentHashes: string[];
  refs: readonly GraphRefDTO[];
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
      out.push({ kind: 'remote', name: r.name, isCurrent: false });
    } else {
      out.push({
        kind: 'local',
        name: r.name,
        isCurrent: !!headBranch && r.name === headBranch,
        syncedRemote: syncedRemoteFor.get(r.name)?.name,
      });
    }
  }
  return out;
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
