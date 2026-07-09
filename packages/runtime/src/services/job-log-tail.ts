/**
 * @domain subdomain: Jobs
 * @domain subdomain-type: supporting
 * @domain type: util
 * @domain layer: application
 *
 * Pure helpers for turning a raw background-job logfile into a compact "last
 * output" tail safe to persist as a chat message.
 *
 * Why this exists: progress bars (tqdm, curl, docker, …) repaint a single
 * visual line by emitting many states separated by carriage returns
 * (`0%…\r5%…\r…\r100%…`) WITHOUT a newline between them. A naive
 * `split('\n').slice(-N)` therefore keeps the whole progress history as one
 * monster line — we saw real jobs persist 350 KB+ single-line messages, which
 * jank the client badly when the thread is opened. Collapsing the carriage
 * returns (keeping only what a terminal would have left visible) plus a hard
 * byte cap keeps the persisted tail small.
 */

// CSI / SGR escape sequences (colors, cursor moves). Mirrors the lightweight
// strippers already used in skills-service.ts and coverage-gate.ts.
const ANSI_RE = new RegExp(String.raw`\u001B\[[0-9;?]*[ -/]*[@-~]`, 'g');

/** Hard ceiling on the persisted tail, in characters. A single line with no
 *  carriage returns can still be arbitrarily large (e.g. one huge JSON blob),
 *  so cap as defense in depth even after collapsing CR overwrites. */
export const MAX_TAIL_CHARS = 16_000;

/**
 * Collapse terminal carriage-return overwrites within one line: a progress bar
 * emits many `…\r…\r…` states inside a single newline-terminated line, but only
 * the final segment after the last `\r` was ever visible. Keep that segment,
 * mirroring how a terminal renders it.
 */
function collapseCarriageReturns(line: string): string {
  const lastCr = line.lastIndexOf('\r');
  return lastCr === -1 ? line : line.slice(lastCr + 1);
}

/**
 * Build a compact tail from raw logfile contents.
 *
 * - Collapses `\r` progress-bar overwrites so repainted lines don't survive.
 * - Strips ANSI escape sequences.
 * - Keeps the last `maxLines` newline-delimited lines.
 * - Caps the result at `MAX_TAIL_CHARS` as a final safety net.
 */
export function buildLogTail(raw: string, maxLines = 50): string {
  const collapsed = raw
    .split('\n')
    .map((line) => collapseCarriageReturns(line).replace(ANSI_RE, ''))
    .slice(-maxLines)
    .join('\n')
    .trim();

  if (!collapsed) return '(empty)';

  if (collapsed.length > MAX_TAIL_CHARS) {
    return `…(truncated)\n${collapsed.slice(-MAX_TAIL_CHARS)}`;
  }
  return collapsed;
}
