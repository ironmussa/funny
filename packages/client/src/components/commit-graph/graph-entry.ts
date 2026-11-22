import { LANE_WIDTH } from '@/components/commit-graph/GraphGutter';
import { isThreadBranchRef } from '@/components/commit-graph/GraphRefChips';
import type { GraphRefDTO } from '@/lib/api/git';
import { foldGraphRefs } from '@/lib/graph-refs';

/** One commit of the branch graph, as the graph-log endpoint returns it. */
export interface GraphEntry {
  hash: string;
  shortHash: string;
  author: string;
  authorEmail: string;
  authoredAt: number;
  committer: string;
  committerEmail: string;
  committedAt: string;
  message: string;
  body: string;
  parentHashes: string[];
  refs: GraphRefDTO[];
  /** Checked-out branch, set only on the commit HEAD points at (else null). */
  headBranch: string | null;
}

export function hasDistinctCommitterIdentity(entry: GraphEntry): boolean {
  return (
    !!entry.committer &&
    (entry.committer !== entry.author ||
      (!!entry.committerEmail && entry.committerEmail !== entry.authorEmail))
  );
}

export const PAGE_SIZE = 80;
// The title/meta text is rendered with the SAME Tailwind classes as the History
// list (`text-xs` + `text-2xs`) so the font is identical across every
// Review-pane tab. These px values are only used to *estimate* row heights for
// the virtualizer — `text-xs` resolves to ~10.5px at the app's 14px rem base,
// and `text-2xs` is an absolute 10px.
export const TITLE_PX = 10.5;
export const META_PX = 10;
export const REBASE_LINK_RAIL_WIDTH = LANE_WIDTH;
export const PARENT_BRANCH_LABEL_MAX_CHARS = 40;
// Upper bound on how many commits the active-filter background pager will pull
// in, so filtering a huge repo can't page the entire history into memory.
export const FILTER_MAX_SCAN = 2000;

// Variable row heights: the title sits on one line, so ref-less rows are a
// single tight line; each branch/tag chip gets its own line above. Computed
// from the font sizes — no magic numbers — so ref-less rows (the majority) stay
// compact instead of padding to a fixed max. Typography is fixed so the font is
// identical across every Review-pane tab (see TITLE_PX / META_PX).
export const GRAPH_BASE_ROW_H = Math.round(TITLE_PX * 1.5) + 6;
// Rows with ref chips get an extra line for the powerline plus a little more
// breathing room so the chips don't crowd the commit title below them.
export const GRAPH_REFS_ROW_H = GRAPH_BASE_ROW_H + (META_PX + 5) + 6;

/** Height of one commit row: one line, plus one per branch/tag chip. */
export function graphRowHeight(entry: Pick<GraphEntry, 'refs' | 'headBranch'>): number {
  const count = foldGraphRefs(entry.refs, entry.headBranch).length;
  return count > 0 ? GRAPH_REFS_ROW_H + (count - 1) * (META_PX + 5 + 4) : GRAPH_BASE_ROW_H;
}

function graphNodeX(lane: number): number {
  return 12 + lane * LANE_WIDTH + LANE_WIDTH / 2;
}

export function rebaseLinkNodeEdgeX(lane: number): number {
  return graphNodeX(lane) + LANE_WIDTH / 2 + 2;
}

/** Index of the row whose chips include the local branch `branch`, or -1. */
export function findThreadBranchRowIndex(
  entries: readonly Pick<GraphEntry, 'refs' | 'headBranch'>[],
  branch: string | null,
): number {
  if (!branch) return -1;
  return entries.findIndex((entry) =>
    foldGraphRefs(entry.refs, entry.headBranch).some((ref) => isThreadBranchRef(ref, branch)),
  );
}

function refsContentHeight(entry: Pick<GraphEntry, 'refs' | 'headBranch'>): number {
  const chipLineH = META_PX + 5;
  const titleLineH = Math.round(TITLE_PX * 1.5);
  const count = foldGraphRefs(entry.refs, entry.headBranch).length;
  return count * chipLineH + (count - 1) * 4 + 6 + titleLineH;
}

export function nodeYForRow(
  entry: Pick<GraphEntry, 'refs' | 'headBranch'>,
  rowHeight: number,
): number {
  if (entry.refs.length === 0) return rowHeight / 2;
  return (rowHeight - refsContentHeight(entry)) / 2 + (META_PX + 5) / 2;
}

/**
 * Center Y of the commit title line. In a row with branch/tag chips the title
 * sits under the chips, so it is below the row's middle.
 */
export function titleYForRow(
  entry: Pick<GraphEntry, 'refs' | 'headBranch'>,
  rowHeight: number,
): number {
  if (entry.refs.length === 0) return rowHeight / 2;
  const titleLineH = Math.round(TITLE_PX * 1.5);
  return (rowHeight + refsContentHeight(entry)) / 2 - titleLineH / 2;
}
