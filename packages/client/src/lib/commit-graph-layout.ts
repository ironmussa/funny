const GRAPH_GUTTER_MAX_VIEWPORT_PX = 320;
const GRAPH_GUTTER_MIN_VIEWPORT_PX = 64;
const GRAPH_GUTTER_PANEL_RATIO = 0.42;

export function graphGutterViewportWidth(gutterWidth: number, containerWidth: number): number {
  if (gutterWidth <= 0) return 0;
  if (containerWidth <= 0) return Math.min(gutterWidth, GRAPH_GUTTER_MAX_VIEWPORT_PX);
  const responsiveCap = Math.floor(containerWidth * GRAPH_GUTTER_PANEL_RATIO);
  const cappedWidth = Math.max(
    GRAPH_GUTTER_MIN_VIEWPORT_PX,
    Math.min(GRAPH_GUTTER_MAX_VIEWPORT_PX, responsiveCap),
  );
  return Math.min(gutterWidth, cappedWidth);
}

export function renderedGraphLaneCount(layoutLaneCount: number): number {
  return Math.max(layoutLaneCount, 1);
}

export function graphRefLeaderLineXRange({
  nodeX,
  avatarR,
  graphViewportWidth,
  chipLeftX,
}: {
  nodeX: number;
  avatarR: number;
  graphViewportWidth: number;
  chipLeftX: number;
}): { x1: number; x2: number } | null {
  const gutterLeftX = 12;
  const gutterRightX = gutterLeftX + graphViewportWidth;
  if (nodeX > gutterRightX + avatarR) return null;
  const x1 = Math.max(nodeX + avatarR, gutterLeftX);
  if (x1 >= chipLeftX) return null;
  return { x1, x2: chipLeftX };
}

const THREAD_BRANCH_SHAFT_ELBOW_PX = 12;

/**
 * Path of the arrow shaft for the open thread's branch chip when it is not the
 * first chip of its row. The row's leader line only reaches the first chip, so
 * this branches off it just before the chips and turns down to the thread
 * chip's center, ending where the arrowhead marker starts.
 */
export function threadBranchShaftPath({
  x1,
  chipLeftX,
  leaderY,
  threadChipY,
}: {
  x1: number;
  chipLeftX: number;
  leaderY: number;
  threadChipY: number;
}): string | null {
  const drop = threadChipY - leaderY;
  if (drop <= 0) return null;
  const elbowX = Math.max(x1, chipLeftX - THREAD_BRANCH_SHAFT_ELBOW_PX);
  const radius = Math.min(5, drop / 2, chipLeftX - elbowX);
  if (radius <= 0) {
    return `M ${x1} ${leaderY} L ${elbowX} ${leaderY} L ${elbowX} ${threadChipY} L ${chipLeftX} ${threadChipY}`;
  }
  return [
    `M ${x1} ${leaderY}`,
    `L ${elbowX} ${leaderY}`,
    `L ${elbowX} ${threadChipY - radius}`,
    `Q ${elbowX} ${threadChipY} ${elbowX + radius} ${threadChipY}`,
    `L ${chipLeftX} ${threadChipY}`,
  ].join(' ');
}
