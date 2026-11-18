/**
 * Terminal escape sequences, the one stripper every package uses (client
 * cards, runtime check and job tails, skills errors, the coverage gate).
 * Browser-safe: no Node imports.
 */

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

/** CSI (`ESC [ … final`: colors, cursor moves), OSC (`ESC ] … BEL|ST`: titles, links) and two-byte escapes. */
const ANSI_PATTERN = new RegExp(
  `${ESC}\\[[0-?]*[ -/]*[@-~]|${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)|${ESC}[@-_]`,
  'g',
);

/** `text` without terminal escape sequences (colors, cursor moves, titles, links). */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '');
}

/** Whether `text` carries any terminal escape sequence. */
export function hasAnsi(text: string): boolean {
  return stripAnsi(text) !== text;
}
