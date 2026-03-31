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

  for (const line of lines) {
    if (line.startsWith('@@')) {
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith('---') || line.startsWith('+++')) continue;

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
 * Parse the new (right) side of a unified diff.
 *
 * Same header-skipping logic as {@link parseDiffOld}, but keeps added (`+`)
 * lines and discards removed (`-`) lines.
 */
export function parseDiffNew(unifiedDiff: string): string {
  const lines = unifiedDiff.split('\n');
  const newLines: string[] = [];
  let inHunk = false;

  for (const line of lines) {
    if (line.startsWith('@@')) {
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith('---') || line.startsWith('+++')) continue;

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
