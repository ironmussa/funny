/**
 * Compute a minimal unified diff from old/new strings.
 * Used when we only have tool call old_string/new_string (no raw git diff).
 *
 * Simple diff: find the common prefix/suffix and show the middle as all
 * removals then all additions, with up to 3 context lines on each side. An LCS
 * diff would be more accurate, but this is sufficient for inline edit cards
 * where changes are small and localized.
 *
 * `snippetBaseLine` is the 1-indexed line in the actual file where the
 * snippet begins, so the hunk header reflects the real file location
 * instead of snippet-relative numbering. Defaults to 1.
 */
export function computeUnifiedDiff(
  oldValue: string,
  newValue: string,
  snippetBaseLine: number = 1,
): string {
  const oldLines = oldValue.split('\n');
  const newLines = newValue.split('\n');
  const lines: string[] = [];

  lines.push('--- a/file');
  lines.push('+++ b/file');

  let prefixLen = 0;
  while (
    prefixLen < oldLines.length &&
    prefixLen < newLines.length &&
    oldLines[prefixLen] === newLines[prefixLen]
  ) {
    prefixLen++;
  }

  let suffixLen = 0;
  while (
    suffixLen < oldLines.length - prefixLen &&
    suffixLen < newLines.length - prefixLen &&
    oldLines[oldLines.length - 1 - suffixLen] === newLines[newLines.length - 1 - suffixLen]
  ) {
    suffixLen++;
  }

  const oldChanged = oldLines.slice(prefixLen, oldLines.length - suffixLen);
  const newChanged = newLines.slice(prefixLen, newLines.length - suffixLen);

  const ctxBefore = Math.min(prefixLen, 3);
  const ctxAfter = Math.min(suffixLen, 3);
  const hunkOldStart = snippetBaseLine + prefixLen - ctxBefore;
  const hunkNewStart = snippetBaseLine + prefixLen - ctxBefore;
  const hunkOldLen = ctxBefore + oldChanged.length + ctxAfter;
  const hunkNewLen = ctxBefore + newChanged.length + ctxAfter;

  lines.push(`@@ -${hunkOldStart},${hunkOldLen} +${hunkNewStart},${hunkNewLen} @@`);

  for (let i = prefixLen - ctxBefore; i < prefixLen; i++) {
    lines.push(` ${oldLines[i]}`);
  }
  for (const l of oldChanged) lines.push(`-${l}`);
  for (const l of newChanged) lines.push(`+${l}`);
  for (let i = oldLines.length - suffixLen; i < oldLines.length - suffixLen + ctxAfter; i++) {
    lines.push(` ${oldLines[i]}`);
  }

  return lines.join('\n');
}
