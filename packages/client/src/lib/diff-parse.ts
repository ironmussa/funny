/**
 * Parse the old (left) side of a unified diff.
 *
 * Skips diff metadata headers (diff --git, index, etc.) by only processing
 * lines after the first `@@` hunk marker.  Strips the single-character prefix
 * from both removed (`-`) and context (` `) lines so the reconstructed source
 * has correct indentation for syntax highlighting.
 */
export function parseDiffOld(unifiedDiff: string): string {
  const lines = unifiedDiff.split('\n');
  const oldLines: string[] = [];
  let inHunk = false;
  let combinedPrefixWidth = 0;

  for (const line of lines) {
    const combinedHunkMatch = /^@@@ ((?:-\d+(?:,\d+)? )+)\+\d+(?:,\d+)? @@@/.exec(line);
    if (combinedHunkMatch) {
      inHunk = true;
      combinedPrefixWidth = (combinedHunkMatch[1].match(/-\d+(?:,\d+)?/g) ?? []).length;
      continue;
    }
    if (line.startsWith('@@')) {
      inHunk = true;
      combinedPrefixWidth = 0;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith('---') || line.startsWith('+++')) continue;
    if (line.startsWith('\\')) continue;

    if (combinedPrefixWidth > 0) {
      const prefix = line.slice(0, combinedPrefixWidth);
      // Lines marked with `+` are new in the merge result and therefore do
      // not belong to the synthetic before side of the inline card.
      if (!prefix.includes('+')) oldLines.push(line.slice(combinedPrefixWidth));
      continue;
    }

    if (line.startsWith('-')) {
      oldLines.push(line.substring(1));
    } else if (line.startsWith('+')) {
      continue;
    } else {
      // Context line: strip the leading space prefix
      oldLines.push(line.length > 0 && line[0] === ' ' ? line.substring(1) : line);
    }
  }

  return oldLines.join('\n');
}

/**
 * Count added/removed lines in a unified diff. Handles input made of several
 * concatenated per-file diffs (the session tool-call fallback joins one diff
 * per edit), using the same header-skipping logic as {@link parseDiffOld}.
 */
export function countDiffStats(unifiedDiff: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  let inHunk = false;

  for (const line of unifiedDiff.split('\n')) {
    if (line.startsWith('@@')) {
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith('---') || line.startsWith('+++')) continue;

    if (line.startsWith('+')) additions++;
    else if (line.startsWith('-')) deletions++;
  }

  return { additions, deletions };
}

/**
 * Parse the new (right) side of a unified diff.
 *
 * Same header-skipping logic as {@link parseDiffOld}, but keeps added (`+`)
 * lines and discards removed (`-`) lines.
 */
export function parseDiffNew(unifiedDiff: string): string {
  const lines = unifiedDiff.split('\n');
  const newLines: string[] = [];
  let inHunk = false;
  let combinedPrefixWidth = 0;

  for (const line of lines) {
    const combinedHunkMatch = /^@@@ ((?:-\d+(?:,\d+)? )+)\+\d+(?:,\d+)? @@@/.exec(line);
    if (combinedHunkMatch) {
      inHunk = true;
      combinedPrefixWidth = (combinedHunkMatch[1].match(/-\d+(?:,\d+)?/g) ?? []).length;
      continue;
    }
    if (line.startsWith('@@')) {
      inHunk = true;
      combinedPrefixWidth = 0;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith('---') || line.startsWith('+++')) continue;
    if (line.startsWith('\\')) continue;

    if (combinedPrefixWidth > 0) {
      const prefix = line.slice(0, combinedPrefixWidth);
      // Lines marked with `-` are absent from the merge result and therefore
      // do not belong to the synthetic after side of the inline card.
      if (!prefix.includes('-')) newLines.push(line.slice(combinedPrefixWidth));
      continue;
    }

    if (line.startsWith('+')) {
      newLines.push(line.substring(1));
    } else if (line.startsWith('-')) {
      continue;
    } else {
      // Context line: strip the leading space prefix
      newLines.push(line.length > 0 && line[0] === ' ' ? line.substring(1) : line);
    }
  }

  return newLines.join('\n');
}
