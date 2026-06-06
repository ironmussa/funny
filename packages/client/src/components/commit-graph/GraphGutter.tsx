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
}: Props) {
  const width = laneCount * LANE_WIDTH;
  const y = (frac: number) => frac * height;
  const clipId = useId();
  const nodeX = laneX(row.commitLane);
  const nodeY = y(0.5);
  const nodeColor = graphLanePastel(row.nodeColor);
  const initials = avatarUrl ? '' : initialsOf(authorName ?? '');
  // Node scales with the row height (capped to the lane width so it never spills
  // into a neighbouring rail). Plain dot is half the avatar size.
  const avatarR = Math.min(LANE_WIDTH / 2, Math.max(6, Math.round(height * 0.15)));
  const dotR = Math.max(3, Math.round(avatarR / 2));

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
        const y1 = y(s.fromY);
        const x2 = laneX(s.toLane);
        const y2 = y(s.toY);
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
        // Smooth S-curve between lanes for diagonal segments.
        const midY = (y1 + y2) / 2;
        return (
          <path
            key={i}
            d={`M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`}
            fill="none"
            stroke={color}
            strokeWidth={STROKE_WIDTH}
          />
        );
      })}
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
    </svg>
  );
});
