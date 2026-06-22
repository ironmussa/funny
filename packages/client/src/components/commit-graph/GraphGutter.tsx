import { memo, useId } from 'react';

import type { GraphRow } from '@/lib/git-graph-lanes';
import { graphLanePastel } from '@/lib/graph-colors';

// Wide enough that an avatar node sits inside a single lane without colliding
// with neighbouring rails. The node radius is derived from the row height (which
// itself scales with the font-size setting), so the graph scales with the text.
export const LANE_WIDTH = 16;
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
  /** Committer avatar shown as a secondary badge when it differs from the author. */
  committerAvatarUrl?: string;
  /** Committer name — used to render initials in the badge when no avatar is available. */
  committerName?: string;
  /**
   * Draw a dashed stub from the node up to the top edge — used on the HEAD row to
   * connect it to the "Uncommitted changes" (WIP) node sitting above the list.
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
function initialsOf(name: string): string {
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
  committerAvatarUrl,
  committerName,
  connectUp,
  nodeYFrac = 0.5,
}: Props) {
  const width = laneCount * LANE_WIDTH;
  const y = (frac: number) => frac * height;
  // Rail joints meeting the node carry fractional Y of exactly 0.5; remap those
  // onto the (possibly raised) node center so segments still land on the node.
  const segY = (frac: number) => (frac === 0.5 ? y(nodeYFrac) : y(frac));
  const clipId = useId();
  const committerClipId = useId();
  const nodeX = laneX(row.commitLane);
  const nodeY = y(nodeYFrac);
  const nodeColor = graphLanePastel(row.nodeColor);
  const initials = avatarUrl ? '' : initialsOf(authorName ?? '');
  const committerInitials = committerAvatarUrl ? '' : initialsOf(committerName ?? '');
  // Node scales with the row height (capped to the lane width so it never spills
  // into a neighbouring rail). Plain dot is half the avatar size.
  const avatarR = Math.min(LANE_WIDTH / 2, Math.max(6, Math.round(height * 0.15)));
  const dotR = Math.max(3, Math.round(avatarR / 2));
  const badgeR = Math.max(4, Math.round(avatarR * 0.56));
  const badgeX = nodeX + avatarR * 0.62;
  const badgeY = nodeY + avatarR * 0.62;

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
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        );
      })}
      {/* Dashed stub up to the WIP node above (HEAD row only). */}
      {connectUp && (
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
      {committerName ? (
        <g>
          <circle
            cx={badgeX}
            cy={badgeY}
            r={badgeR + 1.5}
            fill="hsl(var(--background))"
            stroke={nodeColor}
            strokeWidth={1}
          />
          {committerAvatarUrl ? (
            <>
              <defs>
                <clipPath id={committerClipId}>
                  <circle cx={badgeX} cy={badgeY} r={badgeR} />
                </clipPath>
              </defs>
              <image
                href={committerAvatarUrl}
                x={badgeX - badgeR}
                y={badgeY - badgeR}
                width={badgeR * 2}
                height={badgeR * 2}
                clipPath={`url(#${committerClipId})`}
                preserveAspectRatio="xMidYMid slice"
              />
            </>
          ) : committerInitials ? (
            <>
              <circle cx={badgeX} cy={badgeY} r={badgeR} fill={nodeColor} fillOpacity={0.28} />
              <text
                x={badgeX}
                y={badgeY}
                textAnchor="middle"
                dominantBaseline="central"
                className="font-sans"
                fontSize={Math.max(4, badgeR + 1)}
                fontWeight={700}
                fill={nodeColor}
              >
                {committerInitials}
              </text>
            </>
          ) : (
            <circle cx={badgeX} cy={badgeY} r={Math.max(2.5, badgeR - 1)} fill={nodeColor} />
          )}
        </g>
      ) : null}
    </svg>
  );
});
