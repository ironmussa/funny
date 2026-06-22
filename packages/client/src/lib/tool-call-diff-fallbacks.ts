import type { FileDiffSummary } from '@funny/shared';

type ToolCallLike = {
  name?: string;
  input?: unknown;
};

type ToolItemLike =
  | { type: 'toolcall'; tc: ToolCallLike }
  | { type: 'toolcall-group'; calls: ToolCallLike[] }
  | { type: 'toolcall-run'; items: ToolItemLike[] };

function inputRecord(input: unknown): Record<string, unknown> | null {
  if (typeof input === 'string') {
    try {
      const parsed = JSON.parse(input);
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
  return input && typeof input === 'object' ? (input as Record<string, unknown>) : null;
}

function matchesPath(toolPath: string, summaryPath: string): boolean {
  return toolPath === summaryPath || toolPath.endsWith(`/${summaryPath}`);
}

function fileKeyForToolPath(toolPath: string, files: FileDiffSummary[]): string | null {
  return files.find((file) => matchesPath(toolPath, file.path))?.path ?? null;
}

function computeUnifiedDiff(filePath: string, oldValue: string, newValue: string): string {
  const oldLines = oldValue.split('\n');
  const newLines = newValue.split('\n');
  const lines = [`--- a/${filePath}`, `+++ b/${filePath}`];

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
  const hunkOldStart = Math.max(1, prefixLen - ctxBefore + 1);
  const hunkNewStart = Math.max(1, prefixLen - ctxBefore + 1);
  const hunkOldLen = ctxBefore + oldChanged.length + ctxAfter;
  const hunkNewLen = ctxBefore + newChanged.length + ctxAfter;

  lines.push(`@@ -${hunkOldStart},${hunkOldLen} +${hunkNewStart},${hunkNewLen} @@`);

  for (let i = prefixLen - ctxBefore; i < prefixLen; i++) lines.push(` ${oldLines[i]}`);
  for (const line of oldChanged) lines.push(`-${line}`);
  for (const line of newChanged) lines.push(`+${line}`);
  for (let i = oldLines.length - suffixLen; i < oldLines.length - suffixLen + ctxAfter; i++) {
    lines.push(` ${oldLines[i]}`);
  }

  return lines.join('\n');
}

function addDiff(
  diffs: Map<string, string[]>,
  key: string,
  oldValue: unknown,
  newValue: unknown,
): void {
  if (typeof oldValue !== 'string' || typeof newValue !== 'string') return;
  if (oldValue === newValue) return;
  const list = diffs.get(key) ?? [];
  list.push(computeUnifiedDiff(key, oldValue, newValue));
  diffs.set(key, list);
}

function collectFromToolCall(
  toolCall: ToolCallLike,
  files: FileDiffSummary[],
  diffs: Map<string, string[]>,
): void {
  const input = inputRecord(toolCall.input);
  if (!input) return;
  const toolPath = input?.file_path;
  if (typeof toolPath !== 'string') return;
  const key = fileKeyForToolPath(toolPath, files);
  if (!key) return;

  if (toolCall.name === 'Edit') {
    addDiff(diffs, key, input.old_string, input.new_string);
    return;
  }

  if (toolCall.name === 'MultiEdit' && Array.isArray(input.edits)) {
    for (const edit of input.edits) {
      const record = edit && typeof edit === 'object' ? (edit as Record<string, unknown>) : null;
      addDiff(diffs, key, record?.old_string, record?.new_string);
    }
    return;
  }

  if (toolCall.name === 'Write' && typeof input.content === 'string') {
    addDiff(diffs, key, '', input.content);
  }
}

function collectFromItem(
  item: ToolItemLike,
  files: FileDiffSummary[],
  diffs: Map<string, string[]>,
): void {
  switch (item.type) {
    case 'toolcall':
      collectFromToolCall(item.tc, files, diffs);
      return;
    case 'toolcall-group':
      for (const toolCall of item.calls) collectFromToolCall(toolCall, files, diffs);
      return;
    case 'toolcall-run':
      for (const child of item.items) collectFromItem(child, files, diffs);
      return;
  }
}

export function buildToolCallDiffFallbacks(
  items: unknown[],
  files: FileDiffSummary[],
): Map<string, string> {
  const diffs = new Map<string, string[]>();
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const record = item as { type?: unknown };
    if (
      record.type !== 'toolcall' &&
      record.type !== 'toolcall-group' &&
      record.type !== 'toolcall-run'
    ) {
      continue;
    }
    collectFromItem(item as ToolItemLike, files, diffs);
  }
  return new Map([...diffs].map(([path, chunks]) => [path, chunks.join('\n')]));
}
