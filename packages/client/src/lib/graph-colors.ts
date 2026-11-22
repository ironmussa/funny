import { hslToHex } from '@/components/ui/project-chip';
import { stringHash } from '@/lib/string-hash';

/**
 * Categorical lane palette for the commit graph — the single source of truth
 * for every lane color: `[hue, saturation, lightness]` of the rendered color.
 * Two tiers, so neighbours differ in lightness as well as hue (pastel alone
 * flattens sixteen hues into look-alikes):
 * - the first eight are soft pastels (the original palette; lane-index callers
 *   still get these in the original order);
 * - the next eight are deeper, saturated tones on hues interleaved between them.
 * Chips pick their text color with `contrastText()`, so both tiers stay legible.
 */
const GRAPH_LANE_HSL: ReadonlyArray<readonly [number, number, number]> = [
  // Pastel tier.
  [217, 0.7, 0.74],
  [142, 0.62, 0.74],
  [263, 0.68, 0.74],
  [38, 0.7, 0.74],
  [0, 0.7, 0.74],
  [190, 0.7, 0.74],
  [330, 0.7, 0.74],
  [165, 0.64, 0.74],
  // Deep tier.
  [22, 0.9, 0.55],
  [238, 0.75, 0.62],
  [88, 0.7, 0.42],
  [300, 0.65, 0.55],
  [50, 0.95, 0.5],
  [275, 0.7, 0.6],
  [120, 0.6, 0.38],
  [350, 0.8, 0.55],
];

const GRAPH_LANE_HEX = GRAPH_LANE_HSL.map(([h, s, l]) => hslToHex(h, s, l));

/**
 * Lane color for a graph lane index or color key, cycling through the
 * 16-slot palette (and handling negative indices). Single source of truth for
 * every colored surface in the commit graph — the gutter lines/nodes AND the
 * powerline branch chips — so a branch's chip, node, and line are all the exact
 * same color.
 */
export function graphLanePastel(index: number): string {
  const n = GRAPH_LANE_HEX.length;
  return GRAPH_LANE_HEX[((index % n) + n) % n];
}

/**
 * Stable lane color index for a branch (or commit) identifier, so a branch
 * keeps the same color across reloads and layouts instead of taking the color
 * of whatever lane it lands on. Feed it to `graphLanePastel()`.
 */
export function graphColorKey(identifier: string): number {
  return stringHash(identifier);
}
