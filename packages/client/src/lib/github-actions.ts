import type { ActionJob, ActionRun, ActionStatus, CICheckConclusion } from '@funny/shared';

/**
 * Pure helpers for the Actions tab: how long a run or job took, and where the
 * repository's Actions page is.
 */

/** `1h 2m`, `3m 4s`, `5s`. */
export function formatActionDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function elapsed(start: string | null, end: string | null, now: number): number | null {
  if (!start) return null;
  const from = Date.parse(start);
  const to = end ? Date.parse(end) : now;
  return Number.isNaN(from) || Number.isNaN(to) ? null : to - from;
}

/** A run's duration: until its last update once finished, until now while it runs. */
export function runDurationMs(run: ActionRun, now = Date.now()): number | null {
  const end = run.status === 'completed' ? run.updated_at : null;
  return elapsed(run.run_started_at ?? run.created_at, end, now);
}

export function jobDurationMs(job: ActionJob, now = Date.now()): number | null {
  return elapsed(job.started_at, job.completed_at, now);
}

/** `https://github.com/o/r/actions` from any run's URL. */
export function repoActionsUrl(runs: readonly ActionRun[]): string | null {
  const url = runs[0]?.html_url;
  const at = url?.indexOf('/actions/runs/') ?? -1;
  return url && at > 0 ? `${url.slice(0, at)}/actions` : null;
}

const FAILED = new Set(['failure', 'timed_out', 'startup_failure']);

/** A finished run with a failed job, the case GitHub's "Re-run failed jobs" covers. */
export function canRerunFailed(run: ActionRun): boolean {
  return isFailed(run);
}

/** A finished job or step that failed. */
export function isFailed(item: { status: ActionStatus; conclusion: CICheckConclusion }): boolean {
  return item.status === 'completed' && FAILED.has(item.conclusion ?? '');
}
