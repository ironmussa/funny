/**
 * The changed-files session summary and the git status a run's end emits.
 * Split out of agent-message-handler.ts.
 */

import { isAbsolute } from 'node:path';

import {
  getStatusSummary,
  deriveGitSyncState,
  getDiffSummary,
  getIgnoredFileStats,
  getExternalRepoFileStats,
} from '@funny/core/git';
import type { FileDiffSummary } from '@funny/shared';
import { latestSessionChanges } from '@funny/shared';

import { log } from '../../lib/logger.js';
import { computeBranchKey } from '../../utils/git-status-helpers.js';
import { getServices } from '../service-registry.js';
import { canDoGitOps } from '../thread-context.js';
import type { HandlerContext } from './context.js';
import { backfillStats } from './message-helpers.js';

/** How many recent messages are read first to find the latest user turn. */
export const LATEST_TURN_WINDOW = 100;

/**
 * The thread with enough recent history to cover its latest user turn,
 * which is all `latestSessionChanges` reads. Fetching the whole history at
 * every turn end moved megabytes over the runner tunnel on long threads.
 * The newest window is enough when it holds a user message (the newest one
 * in the window is then the newest overall, and its turn follows it inside
 * the window); otherwise the turn started earlier and the full history is
 * loaded as before.
 */
export async function loadLatestTurn(ctx: HandlerContext, threadId: string): Promise<any> {
  const recent = await ctx.threadManager.getThreadWithMessages(threadId, LATEST_TURN_WINDOW);
  const messages: { role?: string }[] = recent?.messages ?? [];
  if (!recent || !recent.hasMore || messages.some((m) => m.role === 'user')) return recent;
  return ctx.threadManager.getThreadWithMessages(threadId);
}

/**
 * Claims this run's changed-files summary. A run can end through more than
 * one path (result, then stop/exit); only the first claim persists it.
 */
function claimChangedFilesSummary(ctx: HandlerContext, threadId: string): boolean {
  if (ctx.state.changedFilesSummaryPersisted.has(threadId)) return false;
  ctx.state.changedFilesSummaryPersisted.add(threadId);
  return true;
}

/** The thread's worktree, else its project directory; '' when neither is known. */
async function summaryCwd(
  ctx: HandlerContext,
  data: { projectId?: string; worktreePath?: string | null },
): Promise<string> {
  const project = data.projectId ? await ctx.getProject(data.projectId) : null;
  return data.worktreePath || project?.path || '';
}

/** The working-tree diff taken when the run started, if the scan succeeded. */
async function runDiffBaseline(
  ctx: HandlerContext,
  threadId: string,
): Promise<FileDiffSummary[] | undefined> {
  return (await ctx.state.runDiffBaselines.get(threadId)) ?? undefined;
}

/**
 * Snapshot the files modified during the just-completed session and persist
 * them as a `changed_files_summary` thread event, keyed by the session's
 * user-message id. Called once per run from every terminal path (result,
 * stop, failure). The file list comes from the session's file-mutating tool
 * calls plus, when it ran shell commands, the working-tree changes since the
 * run's baseline; +/- stats from a one-shot working-tree diff at completion. The
 * snapshot is frozen — the client renders it verbatim on reload instead of
 * recomputing against the live working tree.
 */
export async function persistChangedFilesSummary(
  ctx: HandlerContext,
  threadId: string,
): Promise<void> {
  if (!claimChangedFilesSummary(ctx, threadId)) return;

  const data = await loadLatestTurn(ctx, threadId);
  if (!data) return;
  // Scratch threads have no repo — nothing to diff or summarize.
  if (!canDoGitOps(data as { isScratch?: boolean })) return;

  const messages = (data as { messages?: any[] }).messages ?? [];
  if (messages.length === 0) return;

  const cwd = await summaryCwd(ctx, data);
  if (!cwd) return;

  // Best-effort working-tree diff for +/- stats. A failure (or a clean tree)
  // just yields stat-less rows — the file list still comes from tool calls.
  let changedFiles: FileDiffSummary[] = [];
  const diffResult = await getDiffSummary(cwd);
  if (diffResult.isOk()) changedFiles = diffResult.value.files;

  const baseline = await runDiffBaseline(ctx, threadId);
  const summary = latestSessionChanges(messages, changedFiles, cwd, baseline);
  if (!summary) return;

  // Gitignored files (e.g. openspec/ docs) never appear in the working-tree
  // diff above, so latestSessionChanges leaves them stat-less and the in-chat
  // summary shows no +/-. Backfill line counts for the ignored subset only —
  // tracked stat-less files (committed/reverted) stay stat-less, as they
  // should. See getIgnoredFileStats for why ignored files count as additions.
  const statless = summary.files.filter((f) => f.additions == null).map((f) => f.path);
  if (statless.length > 0) {
    const ignoredStats = await getIgnoredFileStats(cwd, statless);
    if (ignoredStats.isOk() && ignoredStats.value.size > 0) {
      summary.files = backfillStats(summary.files, ignoredStats.value);
    }
  }

  // Files the agent edited by ABSOLUTE path outside the thread's repo (e.g. a
  // sibling repo) never appear in the in-repo diff above, so they stay
  // stat-less with their absolute path preserved. Backfill +/- from each
  // file's OWN enclosing git repo so the row carries stats like any other.
  const externalStatless = summary.files
    .filter((f) => f.additions == null && isAbsolute(f.path))
    .map((f) => f.path);
  if (externalStatless.length > 0) {
    const externalStats = await getExternalRepoFileStats(externalStatless, cwd);
    if (externalStats.isOk() && externalStats.value.size > 0) {
      summary.files = backfillStats(summary.files, externalStats.value);
    }
  }

  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  // Persist via saveThreadEvent — the runtime proxies this to the server's DB
  // (RunnerServiceProvider.createThreadEvent is a no-op, so the explicit-id
  // path would silently drop the event and the card would vanish on reload).
  await getServices().threadEvents.saveThreadEvent(
    threadId,
    'changed_files_summary',
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- source and target types do not overlap, so TS needs the unknown step
    summary as unknown as Record<string, unknown>,
  );

  await ctx.emitWS(threadId, 'thread:event', {
    event: {
      id,
      threadId,
      type: 'changed_files_summary',
      data: JSON.stringify(summary),
      createdAt,
    },
  });

  log.info('Persisted changed-files summary', {
    namespace: 'agent',
    threadId,
    userMessageId: summary.userMessageId,
    fileCount: String(summary.files.length),
  });
}

/** Emit `git:status` for a worktree thread. */
export async function emitGitStatus(ctx: HandlerContext, threadId: string): Promise<void> {
  const thread = await ctx.threadManager.getThread(threadId);
  if (!thread?.worktreePath || thread.mode !== 'worktree') return;

  const project = await ctx.getProject(thread.projectId);
  if (!project) return;

  const summaryResult = await getStatusSummary(
    thread.worktreePath,
    thread.baseBranch ?? undefined,
    project.path,
  );
  if (summaryResult.isErr()) return;
  const summary = summaryResult.value;

  const branchKey = computeBranchKey(thread);

  await ctx.emitWS(threadId, 'git:status', {
    statuses: [
      {
        threadId,
        branchKey,
        state: deriveGitSyncState(summary),
        ...summary,
      },
    ],
  });
}
