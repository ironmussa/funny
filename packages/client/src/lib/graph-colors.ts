import { hslToHex } from '@/components/ui/project-chip';
import { stringHash } from '@/lib/string-hash';

/**
 * Categorical lane palette for the commit graph — the single source of truth
 * for every lane color: `[hue, saturation, lightness]` of the rendered color.
 * All pastels, in two tiers so neighbours differ in lightness as well as hue
 * (one lightness alone flattens sixteen hues into look-alikes):
 * - the first eight are light pastels (lane-index callers get these first);
 * - the next eight are mid pastels, a step darker, on hues interleaved between
 *   them.
 * Chips pick their text color with `contrastText()`, so both tiers stay legible.
 */
const GRAPH_LANE_HSL: ReadonlyArray<readonly [number, number, number]> = [
  // Light tier.
  [217, 0.7, 0.76],
  [142, 0.5, 0.72],
  [263, 0.65, 0.78],
  [38, 0.75, 0.72],
  [0, 0.7, 0.78],
  [190, 0.6, 0.7],
  [330, 0.65, 0.78],
  [165, 0.5, 0.7],
  // Mid tier.
  [22, 0.6, 0.64],
  [238, 0.45, 0.66],
  [88, 0.4, 0.58],
  [300, 0.38, 0.64],
  [50, 0.55, 0.6],
  [275, 0.4, 0.66],
  [120, 0.32, 0.56],
  [350, 0.45, 0.64],
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
