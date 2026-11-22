import { memo, useId } from 'react';

import type { GraphRow } from '@/lib/git-graph-lanes';
import { graphLanePastel } from '@/lib/graph-colors';

// Wide enough that an avatar node sits inside a single lane without colliding
// with neighbouring rails.
export const LANE_WIDTH = 16;
/**
 * Radius of every commit node. Fixed (not derived from the row height) so rows
 * that are taller because they carry branch/tag chips keep the same node size
 * as every other row, and the node column stays aligned.
 */
export const GRAPH_NODE_RADIUS = 6;
const STROKE_WIDTH = 1.6;

interface Props {
  row: GraphRow;
  /** Number of lanes to reserve width for (max across the whole graph). */
  laneCount: number;
  /** Pixel height of the row band the gutter is drawn into. */
  height: number;
  /** Author avatar shown GitKraken-style as the node itself. */
  avatarUrl?: string;
  /** Author name — used to render initials in the node when no avatar is available. */
  authorName?: string;
  /**
   * The committer differs from the author → the node's ring is drawn dashed.
   * Same radius and center as any other node, so the column stays aligned; the
   * committer's identity is shown in the node tooltip.
   */
  distinctCommitter?: boolean;
  /**
   * The "Uncommitted changes" (WIP) node is shown above the list and this row is
   * at or above HEAD: draw the row's HEAD-rail segments (`wip`) dashed. Without
   * them (HEAD not in the window), a dashed stub runs from the node to the top.
   */
  connectUp?: boolean;
  /**
   * Vertical position of the node within the row band, as a fraction (0 = top,
   * 0.5 = center, 1 = bottom). Defaults to 0.5. Rows carrying a branch/tag
   * powerline raise the node to the chip's level so its leader line is a straight
   * horizontal. Rail joints that meet the node (segments with `y = 0.5`) follow.
   */
  nodeYFrac?: number;
}

const laneX = (lane: number) => lane * LANE_WIDTH + LANE_WIDTH / 2;

/** First + last initial (e.g. "Argenis Leon" → "AL"), uppercased. */
export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/**
 * SVG gutter for a single commit row. Drawn per-row (not as one global SVG) so
 * it composes with the virtualized list — only mounted rows render. Segments
 * carry fractional Y (0 top, 0.5 node center, 1 bottom) which we map onto the
 * row band height.
 */
export const GraphGutter = memo(function GraphGutter({
  row,
  laneCount,
  height,
  avatarUrl,
  authorName,
  distinctCommitter,
  connectUp,
  nodeYFrac = 0.5,
}: Props) {
  const width = laneCount * LANE_WIDTH;
  const y = (frac: number) => frac * height;
  // Rail joints meeting the node carry fractional Y of exactly 0.5; remap those
  // onto the (possibly raised) node center so segments still land on the node.
  const segY = (frac: number) => (frac === 0.5 ? y(nodeYFrac) : y(frac));
  const clipId = useId();
  const nodeX = laneX(row.commitLane);
  const nodeY = y(nodeYFrac);
  const nodeColor = graphLanePastel(row.nodeColor);
  const initials = avatarUrl ? '' : initialsOf(authorName ?? '');
  const avatarR = GRAPH_NODE_RADIUS;
  // Plain dot is half the avatar size.
  const dotR = Math.max(3, Math.round(avatarR / 2));
  const ringDash = distinctCommitter ? '2 1.5' : undefined;

  return (
    <svg
      width={width}
      height={height}
      className="shrink-0"
      // `overflow: visible` so the node avatar (which sits centered half a lane
      // from the left edge) isn't clipped by the SVG bounds when it's on lane 0.
      style={{ width, height, overflow: 'visible' }}
      aria-hidden="true"
    >
      {row.segments.map((s, i) => {
        // The HEAD rail above HEAD exists only to connect the WIP node.
        if (s.wip && !connectUp) return null;
        const dash = s.wip ? '2 2' : undefined;
        const x1 = laneX(s.fromLane);
        const y1 = segY(s.fromY);
        const x2 = laneX(s.toLane);
        const y2 = segY(s.toY);
        const color = graphLanePastel(s.color);
        if (x1 === x2) {
          return (
            <line
              key={i}
              x1={x1}
              y1={y1}
              x2={x2}
              y2={y2}
              stroke={color}
              strokeWidth={STROKE_WIDTH}
              strokeDasharray={dash}
            />
          );
        }
        // Orthogonal routing (GitKraken-style): every cross-lane segment has one
        // endpoint at the node center (y = 0.5·h) and the other on a row edge
        // (y = 0 top, or y = h bottom). Draw it as a vertical run inside the edge
        // lane, a rounded quarter-turn at the node's Y, then a horizontal run into
        // the node — so rails stay strictly vertical/horizontal with rounded joints
        // instead of diagonal S-curves.
        const nodeIsFrom = s.fromY === 0.5;
        const xn = nodeIsFrom ? x1 : x2; // node-side x (the lane center we curve into)
        const yn = nodeIsFrom ? y1 : y2; // node-side y (= 0.5·h)
        const xe = nodeIsFrom ? x2 : x1; // edge-side x (vertical run lives here)
        const ye = nodeIsFrom ? y2 : y1; // edge-side y (row top or bottom)
        const r = Math.min(LANE_WIDTH / 2, Math.abs(yn - ye), Math.abs(xn - xe));
        const dx = Math.sign(xn - xe);
        const dy = Math.sign(yn - ye);
        return (
          <path
            key={i}
            d={`M ${xe} ${ye} L ${xe} ${yn - dy * r} Q ${xe} ${yn} ${xe + dx * r} ${yn} L ${xn} ${yn}`}
            fill="none"
            stroke={color}
            strokeWidth={STROKE_WIDTH}
            strokeDasharray={dash}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        );
      })}
      {/* Dashed stub up to the WIP node above, when the layout has no HEAD rail. */}
      {connectUp && !row.segments.some((s) => s.wip) && (
        <line
          x1={nodeX}
          y1={0}
          x2={nodeX}
          y2={nodeY}
          stroke={nodeColor}
          strokeWidth={STROKE_WIDTH}
          strokeDasharray="2 2"
        />
      )}
      {avatarUrl ? (
        <g>
          <defs>
            <clipPath id={clipId}>
              <circle cx={nodeX} cy={nodeY} r={avatarR} />
            </clipPath>
          </defs>
          {/* Backing disc so a transparent avatar still reads as a node. */}
          <circle cx={nodeX} cy={nodeY} r={avatarR} fill="hsl(var(--background))" />
          <image
            href={avatarUrl}
            x={nodeX - avatarR}
            y={nodeY - avatarR}
            width={avatarR * 2}
            height={avatarR * 2}
            clipPath={`url(#${clipId})`}
            preserveAspectRatio="xMidYMid slice"
          />
          {/* Colored ring tying the node to its lane. */}
          <circle
            cx={nodeX}
            cy={nodeY}
            r={avatarR}
            fill="none"
            stroke={nodeColor}
            strokeWidth={STROKE_WIDTH}
            strokeDasharray={ringDash}
          />
        </g>
      ) : initials ? (
        // No GitHub avatar → GitKraken-style initials disc tinted with the lane color.
        <g>
          {/* Solid backing disc so the lane line behind doesn't show through
              the translucent tint (matches the avatar's backing disc). */}
          <circle cx={nodeX} cy={nodeY} r={avatarR} fill="hsl(var(--background))" />
          <circle cx={nodeX} cy={nodeY} r={avatarR} fill={nodeColor} fillOpacity={0.22} />
          <circle
            cx={nodeX}
            cy={nodeY}
            r={avatarR}
            fill="none"
            stroke={nodeColor}
            strokeWidth={STROKE_WIDTH}
            strokeDasharray={ringDash}
          />
          <text
            x={nodeX}
            y={nodeY}
            textAnchor="middle"
            dominantBaseline="central"
            className="font-sans"
            fontSize={avatarR + 1}
            fontWeight={600}
            fill={nodeColor}
          >
            {initials}
          </text>
        </g>
      ) : (
        <circle
          cx={nodeX}
          cy={nodeY}
          r={dotR}
          fill={nodeColor}
          stroke="hsl(var(--background))"
          strokeWidth={1}
        />
      )}
    </svg>
  );
});
