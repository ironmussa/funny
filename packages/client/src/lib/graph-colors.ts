import { hslToHex, pastelize } from '@/components/ui/project-chip';

/**
 * Categorical lane palette for the commit graph — the single source of truth
 * for every lane color. Saturated hues at a mid lightness (this is the "raw"
 * hue source); `graphLanePastel()` softens them into the project-palette pastel
 * range for the surfaces that actually render (gutter lines/nodes + chips).
 */
const GRAPH_LANE_HSL: ReadonlyArray<readonly [number, number, number]> = [
  [217, 0.8, 0.58],
  [142, 0.62, 0.45],
  [263, 0.68, 0.6],
  [38, 0.9, 0.52],
  [0, 0.78, 0.6],
  [190, 0.8, 0.45],
  [330, 0.72, 0.58],
  [165, 0.64, 0.42],
];

const GRAPH_LANE_HEX = GRAPH_LANE_HSL.map(([h, s, l]) => hslToHex(h, s, l));

/**
 * Hex color for a graph lane index, cycling through the 8-slot palette (and
 * handling negative indices). This is the saturated hue source.
 */
export function graphLaneColor(index: number): string {
  const n = GRAPH_LANE_HEX.length;
  return GRAPH_LANE_HEX[((index % n) + n) % n];
}

/**
 * Pastel version of a lane color, in the same soft range as the project-
 * selection palette (lightness ≈ the project pastels). Single source of truth
 * for every pastel surface in the commit graph — the gutter lines/nodes AND the
 * powerline branch chips — so a branch's chip, node, and line are all the exact
 * same color.
 */
export function graphLanePastel(index: number): string {
  return pastelize(graphLaneColor(index), 0.74);
}
