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
  headBranch?: string | null;
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
  } | null;
}

/** Branch portion of a remote ref — remote names never contain `/`. */
const remoteBranchOf = (name: string) => name.slice(name.indexOf('/') + 1);

export type BranchSyncState =
  | 'synced'
  | 'ahead'
  | 'behind'
  | 'diverged'
  | 'local-only'
  | 'remote-only';

export type BranchPrimaryAction = 'none' | 'push' | 'pull' | 'sync' | 'publish' | 'checkout';

export interface GraphBranchSummary {
  branch: string;
  localRef?: string;
  remoteRef?: string;
  localHash?: string;
  remoteHash?: string;
  isCurrent: boolean;
  ahead: number;
  behind: number;
  state: BranchSyncState;
  primaryAction: BranchPrimaryAction;
}

/**
 * A ref as it may arrive over the wire. Current runners send a classified
 * {@link GraphRefDTO}; an older runner (server and runner deploy on independent
 * cycles) may still send a bare string. We tolerate both so a lagging runner
 * degrades to plain named chips instead of blank ones.
 */
export type RawGraphRef = string | GraphRefDTO;

/** A legacy bare-string ref (older runners), not a classified {@link GraphRefDTO}. */
function isLegacyRef(ref: RawGraphRef): ref is string {
  return typeof ref === 'string';
}

function refName(ref: RawGraphRef): string {
  return isLegacyRef(ref) ? ref : ref.name;
}

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
  if (!isLegacyRef(r)) return r;
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
  const named = rawRefs.filter((r) => refName(r).trim() !== '');
  const allNames = new Set(named.map((r) => refName(r)));
  const refs = named.map((r) => normalizeRef(r, allNames));
  const localNames = new Set(refs.flatMap((ref) => (ref.kind === 'local' ? [ref.name] : [])));
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

/**
 * True for git's stash ref (`refs/stash`, the newest entry `stash@{0}`). git log
 * decorates it like a branch, but it cannot be pushed, merged into, rebased onto
 * or used as a thread base: it only offers "drop".
 */
export function isStashRef(name: string): boolean {
  return name === 'refs/stash';
}

/**
 * Branches a new thread can start from at a commit: every branch chip on it
 * (local, or a lone remote-tracking ref named without its remote, since the
 * composer's branch picker lists remote branches by bare name). Tags and the
 * detached-HEAD pseudo-ref are not branches. De-duplicated, chip order kept.
 */
export function threadBaseBranchesAt(refs: readonly FoldedRef[]): string[] {
  const out = new Set<string>();
  for (const ref of refs) {
    if (ref.kind === 'tag' || ref.name === 'HEAD' || isStashRef(ref.name)) continue;
    out.add(ref.kind === 'remote' ? remoteBranchOf(ref.name) : ref.name);
  }
  return [...out];
}

/**
 * Move the open thread's branch chip to the front of a commit's chips, so the
 * row's leader line (and the thread arrow on it) reaches it straight instead of
 * bending down to a lower chip. Other chips keep their order; returns `refs`
 * itself when nothing moves.
 */
export function pinThreadBranchFirst(
  refs: FoldedRef[],
  threadBranch: string | null | undefined,
): FoldedRef[] {
  if (!threadBranch) return refs;
  const index = refs.findIndex((ref) => ref.kind === 'local' && ref.name === threadBranch);
  if (index <= 0) return refs;
  return [refs[index], ...refs.slice(0, index), ...refs.slice(index + 1)];
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

/** What the "forked from" search reads about one loaded commit, computed once. */
interface ForkSearchNode {
  /** The commit's ref label, or null when it carries no branch. */
  label: string | null;
  identities: ReadonlySet<string>;
  /** Parents that are loaded, in order, without repeats. */
  parents: string[];
}

function forkSearchNodes(entries: readonly GraphNodeParentRefEntry[]): Map<string, ForkSearchNode> {
  const loaded = new Set(entries.map((entry) => entry.hash));
  const nodes = new Map<string, ForkSearchNode>();
  for (const entry of entries) {
    const refs = foldGraphRefs(entry.refs, entry.headBranch);
    nodes.set(entry.hash, {
      label: graphNodeRefLabel(refs),
      identities: graphNodeBranchIdentities(refs),
      parents: [...new Set(entry.parentHashes ?? [])].filter((hash) => loaded.has(hash)),
    });
  }
  return nodes;
}

/**
 * Whether each commit has a branch-labelled ancestor among the loaded ones. A
 * search can skip a commit that has neither a label nor such an ancestor: nothing
 * it could reach would answer.
 */
function labelledAncestorFlags(nodes: ReadonlyMap<string, ForkSearchNode>): Map<string, boolean> {
  const flags = new Map<string, boolean>();
  for (const start of nodes.keys()) {
    if (flags.has(start)) continue;
    // Iterative post-order: a commit is decided once all its parents are.
    const stack: string[] = [start];
    while (stack.length > 0) {
      const hash = stack[stack.length - 1];
      if (flags.has(hash)) {
        stack.pop();
        continue;
      }
      const node = nodes.get(hash)!;
      const pending = node.parents.filter((parent) => !flags.has(parent));
      if (pending.length > 0) {
        stack.push(...pending);
        continue;
      }
      stack.pop();
      flags.set(
        hash,
        node.parents.some((parent) => nodes.get(parent)!.label !== null || flags.get(parent)!),
      );
    }
  }
  return flags;
}

/**
 * Breadth-first from `start`'s parents (in their order), the label of the first
 * ancestor with a branch label that shares no branch identity with `own`.
 */
function searchForkedFrom(
  start: ForkSearchNode,
  own: ReadonlySet<string>,
  nodes: ReadonlyMap<string, ForkSearchNode>,
  hasLabelledAncestor: ReadonlyMap<string, boolean>,
): string | null {
  const queue = [...start.parents];
  const seen = new Set<string>();
  for (let head = 0; head < queue.length; head += 1) {
    const hash = queue[head];
    if (seen.has(hash)) continue;
    seen.add(hash);
    const node = nodes.get(hash)!;
    if (node.label && !hasSharedIdentity(own, node.identities)) return node.label;
    for (const parent of node.parents) {
      const next = nodes.get(parent)!;
      if (next.label !== null || hasLabelledAncestor.get(parent)) queue.push(parent);
    }
  }
  return null;
}

const NO_IDENTITIES: ReadonlySet<string> = new Set();

/**
 * Commit hash → the label of the branch it forked from: the nearest ancestor
 * (breadth first, parents in order) with a branch label that is not one of the
 * commit's own branches.
 *
 * Linear in the loaded history for the common case. A commit with no branch of
 * its own and one parent answers with that parent's label, or else with the
 * parent's own answer (the same search, one step further), so a chain is walked
 * once rather than once per commit; a search skips the commits that cannot lead
 * to a label. History pages in 80 commits at a time and this runs on every page.
 */
export function graphNodeForkedFromRefLabels(
  entries: readonly GraphNodeParentRefEntry[],
): Map<string, string> {
  const nodes = forkSearchNodes(entries);
  const hasLabelledAncestor = labelledAncestorFlags(nodes);
  // The answer for a commit with no branch identities of its own.
  const plainAnswers = new Map<string, string | null>();

  const plainAnswer = (start: string): string | null => {
    // Walk down a single-parent chain to the first commit whose answer is known
    // or direct, then fill the chain back in.
    const chain: string[] = [];
    let hash = start;
    let answer: string | null | undefined;
    while (answer === undefined) {
      const known = plainAnswers.get(hash);
      if (known !== undefined) {
        answer = known;
        break;
      }
      const node = nodes.get(hash)!;
      if (node.parents.length !== 1) {
        answer = searchForkedFrom(node, NO_IDENTITIES, nodes, hasLabelledAncestor);
        plainAnswers.set(hash, answer);
        break;
      }
      chain.push(hash);
      const parent = nodes.get(node.parents[0])!;
      if (parent.label) {
        answer = parent.label;
        break;
      }
      hash = node.parents[0];
    }
    for (const link of chain) plainAnswers.set(link, answer);
    return answer;
  };

  const labels = new Map<string, string>();
  for (const entry of entries) {
    const node = nodes.get(entry.hash)!;
    const label =
      node.identities.size === 0
        ? plainAnswer(entry.hash)
        : searchForkedFrom(node, node.identities, nodes, hasLabelledAncestor);
    if (label) labels.set(entry.hash, label);
  }
  return labels;
}

/**
 * Branch label (as shown in a node's tooltip) → hash of the commit its tip sits
 * on, so the tooltip can paint each branch in its tip's lane color. The first
 * entry wins, matching topo order (newest first).
 */
export function graphBranchTipHashByLabel(
  entries: readonly GraphNodeParentRefEntry[],
): Map<string, string> {
  const tips = new Map<string, string>();
  for (const entry of entries) {
    for (const label of graphNodeRefLabels(foldGraphRefs(entry.refs, entry.headBranch))) {
      if (!tips.has(label)) tips.set(label, entry.hash);
    }
  }
  return tips;
}

/**
 * Commit hash → the branch name its graph color is keyed on, for the commits
 * that are branch tips. The checked-out branch wins on a commit with several,
 * then the first local branch, then the first remote one with its remote
 * prefix dropped (so `origin/foo` and `foo` share a color).
 */
export function graphBranchColorNameByHash(
  entries: readonly GraphNodeParentRefEntry[],
): Map<string, string> {
  const names = new Map<string, string>();
  for (const entry of entries) {
    const folded = foldGraphRefs(entry.refs, entry.headBranch);
    const current = folded.find((ref) => ref.kind === 'local' && ref.isCurrent);
    const local = folded.find((ref) => ref.kind === 'local' && ref.name !== 'HEAD');
    const remote = folded.find((ref) => ref.kind === 'remote');
    const name = current?.name ?? local?.name ?? (remote ? remoteBranchOf(remote.name) : null);
    if (name) names.set(entry.hash, name);
  }
  return names;
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

function collectReachableHashes(
  startHash: string | undefined,
  byHash: ReadonlyMap<string, GraphReachabilityEntry>,
): Set<string> {
  const seen = new Set<string>();
  if (!startHash) return seen;
  const stack = [startHash];
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
}

function countOnly(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  let count = 0;
  for (const hash of left) {
    if (!right.has(hash)) count += 1;
  }
  return count;
}

export function summarizeGraphBranches(
  entries: readonly GraphReachabilityEntry[],
): GraphBranchSummary[] {
  const byHash = new Map(entries.map((entry) => [entry.hash, entry]));
  const branches = new Map<string, GraphBranchSummary>();

  const ensure = (branch: string): GraphBranchSummary => {
    const existing = branches.get(branch);
    if (existing) return existing;
    const created: GraphBranchSummary = {
      branch,
      isCurrent: false,
      ahead: 0,
      behind: 0,
      state: 'local-only',
      primaryAction: 'publish',
    };
    branches.set(branch, created);
    return created;
  };

  for (const entry of entries) {
    for (const ref of entry.refs) {
      if (ref.kind === 'tag' || ref.name === 'HEAD' || isStashRef(ref.name)) continue;
      if (ref.kind === 'local') {
        const summary = ensure(ref.name);
        summary.localRef = ref.name;
        summary.localHash = entry.hash;
        summary.isCurrent ||= entry.headBranch === ref.name;
      } else if (ref.kind === 'remote') {
        const branch = remoteBranchOf(ref.name);
        const summary = ensure(branch);
        if (!summary.remoteRef || ref.name.startsWith('origin/')) {
          summary.remoteRef = ref.name;
          summary.remoteHash = entry.hash;
        }
      }
    }
  }

  for (const summary of branches.values()) {
    if (summary.localHash && summary.remoteHash) {
      if (summary.localHash === summary.remoteHash) {
        summary.state = 'synced';
        summary.primaryAction = 'none';
        summary.ahead = 0;
        summary.behind = 0;
        continue;
      }

      const localReachable = collectReachableHashes(summary.localHash, byHash);
      const remoteReachable = collectReachableHashes(summary.remoteHash, byHash);
      summary.ahead = countOnly(localReachable, remoteReachable);
      summary.behind = countOnly(remoteReachable, localReachable);

      if (remoteReachable.has(summary.localHash)) {
        summary.state = 'behind';
        summary.primaryAction = summary.isCurrent ? 'pull' : 'checkout';
      } else if (localReachable.has(summary.remoteHash)) {
        summary.state = 'ahead';
        summary.primaryAction = 'push';
      } else {
        summary.state = 'diverged';
        summary.primaryAction = summary.isCurrent ? 'sync' : 'checkout';
      }
    } else if (summary.localHash) {
      summary.state = 'local-only';
      summary.primaryAction = 'publish';
      summary.ahead = 0;
      summary.behind = 0;
    } else {
      summary.state = 'remote-only';
      summary.primaryAction = 'checkout';
      summary.ahead = 0;
      summary.behind = 0;
    }
  }

  return [...branches.values()].sort((a, b) => {
    if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
    const rank: Record<BranchSyncState, number> = {
      diverged: 0,
      ahead: 1,
      behind: 2,
      'local-only': 3,
      'remote-only': 4,
      synced: 5,
    };
    const byState = rank[a.state] - rank[b.state];
    if (byState !== 0) return byState;
    return a.branch.localeCompare(b.branch);
  });
}

/**
 * The checked-out commit among `entries`: the one carrying the current branch,
 * or the detached-HEAD pseudo-ref. Null when HEAD is outside the window.
 */
export function graphHeadHash(
  entries: readonly Pick<GraphNodeParentRefEntry, 'hash' | 'refs' | 'headBranch'>[],
): string | null {
  const head = entries.find(
    (entry) => !!entry.headBranch || entry.refs.some((ref) => refName(ref) === 'HEAD'),
  );
  return head?.hash ?? null;
}
