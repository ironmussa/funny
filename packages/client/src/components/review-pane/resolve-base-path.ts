/**
 * Resolve the absolute working-directory root for the review pane's file
 * actions (open-in-editor, copy-path, open-directory).
 *
 * The thread-context hooks (`useThreadWorktreePath` / `useThreadProjectId`) read
 * the heavy `threadDataById` map, which loads ~1-2s AFTER `selectedThreadId`
 * flips on a thread click. During that window — or when a thread is opened
 * without a project selected in the sidebar (Activity / All-threads / direct
 * URL) — both are undefined. The lightweight `threadsById` index always carries
 * `projectId` + `worktreePath` for the selected thread, so it's the immediate
 * fallback. Returns `''` only when nothing resolves; callers MUST treat `''` as
 * "not ready" and never build a path from it (a repo-relative path 404s — or
 * worse, silently resolves to the wrong file — against `/files/read`).
 */
export function resolveBasePath(opts: {
  /** Worktree path from the heavy thread-data map (may lag on click). */
  worktreePath?: string | null;
  /** The selected thread from the lightweight `threadsById` index. */
  lightThread?: { worktreePath?: string | null; projectId?: string } | null;
  /** Project id from the heavy thread-data map (may lag on click). */
  threadProjectId?: string | null;
  /** Project selected in the sidebar, if any. */
  selectedProjectId?: string | null;
  /** All known projects (id → absolute path). */
  projects: ReadonlyArray<{ id: string; path: string }>;
}): string {
  const wt = opts.worktreePath ?? opts.lightThread?.worktreePath;
  if (wt) return wt;
  const pid = opts.threadProjectId ?? opts.lightThread?.projectId ?? opts.selectedProjectId;
  if (!pid) return '';
  return opts.projects.find((p) => p.id === pid)?.path ?? '';
}
