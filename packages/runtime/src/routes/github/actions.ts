/**
 * GitHub Actions for the review pane's Actions tab: the repository's workflow
 * runs, a run's jobs and steps, the end of a failed job's log, and re-running
 * a run's failed jobs. Everything goes out with the caller's own GitHub token
 * (`githubRepoFor`); the list and job reads go through `githubApiFetch`, whose
 * ETag cache makes an unchanged poll free against the rate limit.
 */

import type {
  ActionJob,
  ActionJobLog,
  ActionRun,
  ActionRunsPage,
  ActionStatus,
  ActionStep,
  CICheckConclusion,
} from '@funny/shared';
import { Hono, type Context } from 'hono';
import { z } from 'zod';

import { log } from '../../lib/logger.js';
import type { HonoEnv } from '../../types/hono-env.js';
import { parseJsonBody, parseQuery } from '../../validation/request.js';
import { fetchAllPages, GITHUB_API, githubApiFetch, githubRepoFor } from './helpers.js';
import { positiveIntParam, readPaging } from './query.js';

export const actionRoutes = new Hono<HonoEnv>();

/**
 * Log a failed GitHub call (never the token, a signed URL or log contents)
 * and answer 502 with what went wrong.
 */
function upstreamFailure(c: Context<HonoEnv>, action: string, failure: number | Error) {
  const detail = typeof failure === 'number' ? { status: failure } : { error: failure.message };
  log.warn('github actions request failed', { namespace: 'github-actions', action, ...detail });
  const message = typeof failure === 'number' ? `GitHub API error: ${failure}` : failure.message;
  return c.json({ error: message }, 502);
}

/** Lines of a job log the tab shows, ending at the last error. */
const JOB_LOG_TAIL_LINES = 200;

/** Lines kept after the last `##[error]`: GitHub prints the exit code there. */
const LINES_AFTER_ERROR = 3;

/** GitHub's run / job statuses, folded into the three the UI draws. */
function actionStatus(status: unknown): ActionStatus {
  if (status === 'completed') return 'completed';
  if (status === 'in_progress') return 'in_progress';
  return 'queued';
}

function conclusion(value: unknown): CICheckConclusion {
  return typeof value === 'string' ? (value as CICheckConclusion) : null;
}

/** GitHub's JSON is unchecked: a field of the wrong type becomes the fallback. */
const text = (value: unknown, fallback = ''): string =>
  typeof value === 'string' ? value : fallback;
const textOrNull = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const count = (value: unknown, fallback = 0): number =>
  typeof value === 'number' ? value : fallback;

/** The run's title; runs from before `display_title` existed fall back to the commit's subject. */
function runTitle(run: any): string {
  return text(run.display_title, text(run.head_commit?.message).split('\n')[0]);
}

function mapActionRun(run: any): ActionRun {
  return {
    id: run.id,
    name: text(run.name, text(run.path)),
    display_title: runTitle(run),
    run_number: count(run.run_number),
    run_attempt: count(run.run_attempt, 1),
    event: text(run.event),
    status: actionStatus(run.status),
    conclusion: conclusion(run.conclusion),
    head_branch: textOrNull(run.head_branch),
    head_sha: text(run.head_sha),
    html_url: text(run.html_url),
    actor: run.actor ? { login: run.actor.login, avatar_url: run.actor.avatar_url } : null,
    created_at: text(run.created_at),
    run_started_at: textOrNull(run.run_started_at),
    updated_at: text(run.updated_at),
  };
}

function mapActionStep(step: any): ActionStep {
  return {
    number: count(step.number),
    name: text(step.name),
    status: actionStatus(step.status),
    conclusion: conclusion(step.conclusion),
    started_at: textOrNull(step.started_at),
    completed_at: textOrNull(step.completed_at),
  };
}

function mapActionJob(job: any): ActionJob {
  return {
    id: job.id,
    name: text(job.name),
    status: actionStatus(job.status),
    conclusion: conclusion(job.conclusion),
    html_url: textOrNull(job.html_url),
    started_at: textOrNull(job.started_at),
    completed_at: textOrNull(job.completed_at),
    steps: Array.isArray(job.steps) ? job.steps.map(mapActionStep) : [],
  };
}

const TIMESTAMP_PREFIX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z ?/;
const RED = '\x1b[31m';
const RESET = '\x1b[0m';

/** One raw log line without its timestamp, with GitHub's workflow commands made readable. */
function readableLogLine(raw: string): string | null {
  const line = raw.replace(/\r$/, '').replace(TIMESTAMP_PREFIX, '');
  if (line.startsWith('##[endgroup]')) return null;
  if (line.startsWith('##[group]')) return `▸ ${line.slice('##[group]'.length)}`;
  if (line.startsWith('##[error]')) return `${RED}Error: ${line.slice('##[error]'.length)}${RESET}`;
  if (line.startsWith('##[warning]')) return `Warning: ${line.slice('##[warning]'.length)}`;
  return line;
}

/**
 * The part of a job log that explains a failure: up to `maxLines` lines ending
 * a few lines after the last `##[error]` (the post-job cleanup steps that
 * follow it are noise), or the plain tail when the log has no error.
 */
export function extractFailureTail(raw: string, maxLines = JOB_LOG_TAIL_LINES): ActionJobLog {
  const lines = raw.split('\n');
  if (lines.at(-1) === '') lines.pop();
  let lastError = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].includes('##[error]')) {
      lastError = i;
      break;
    }
  }
  const end =
    lastError >= 0 ? Math.min(lines.length, lastError + 1 + LINES_AFTER_ERROR) : lines.length;
  const readable: string[] = [];
  for (const line of lines.slice(0, end)) {
    const out = readableLogLine(line);
    if (out !== null) readable.push(out);
  }
  const start = Math.max(0, readable.length - maxLines);
  return { lines: readable.slice(start), truncated: start > 0 };
}

// ── GET /actions/runs — the repository's workflow runs ──────

const runsQuery = z.object({
  projectId: z.string().min(1, { error: 'projectId is required' }),
  branch: z.string().min(1).max(255).optional(),
  status: z
    .enum(['completed', 'in_progress', 'queued', 'success', 'failure'], {
      error: 'status must be one of: completed, in_progress, queued, success, failure',
    })
    .optional(),
});

actionRoutes.get('/actions/runs', async (c) => {
  const query = parseQuery(c, runsQuery);
  if (query.isErr()) return c.json({ error: query.error.message }, 400);
  const { projectId, branch, status } = query.value;
  const { page, perPage } = readPaging(c, 30);

  const ctx = await githubRepoFor(c, projectId);
  if (ctx instanceof Response) return ctx;

  const params = new URLSearchParams({ per_page: String(perPage), page: String(page) });
  if (branch) params.set('branch', branch);
  if (status) params.set('status', status);

  try {
    const res = await githubApiFetch(
      `/repos/${ctx.owner}/${ctx.repo}/actions/runs?${params.toString()}`,
      ctx.token,
    );
    if (!res.ok) return upstreamFailure(c, 'runs', res.status);
    const body = (await res.json()) as { total_count?: number; workflow_runs?: any[] };
    const runs = (body.workflow_runs ?? []).map(mapActionRun);
    const total = body.total_count ?? runs.length;
    const result: ActionRunsPage = { runs, total_count: total, hasMore: page * perPage < total };
    return c.json(result);
  } catch (error: any) {
    return upstreamFailure(c, 'runs', error);
  }
});

// ── GET /actions/jobs — a run's jobs (latest attempt) and their steps ──────

actionRoutes.get('/actions/jobs', async (c) => {
  const projectId = c.req.query('projectId');
  const runId = positiveIntParam(c, 'runId');
  if (!projectId || !runId) return c.json({ error: 'projectId and runId are required' }, 400);

  const ctx = await githubRepoFor(c, projectId);
  if (ctx instanceof Response) return ctx;

  try {
    // GitHub pages jobs 100 at a time; a big matrix needs the later pages.
    const jobs = await fetchAllPages(
      `/repos/${ctx.owner}/${ctx.repo}/actions/runs/${runId}/jobs?filter=latest`,
      ctx.token,
      'jobs',
    );
    if (!jobs.ok) return upstreamFailure(c, 'jobs', jobs.status);
    return c.json({ jobs: jobs.items.map(mapActionJob) });
  } catch (error: any) {
    return upstreamFailure(c, 'jobs', error);
  }
});

// ── GET /actions/job-log — the end of a job's log ──────

/**
 * GitHub answers a job log request with a redirect to a short-lived signed
 * URL. Follow it by hand, without the token: the token must not leave GitHub,
 * and signed storage URLs can refuse a request that carries one.
 */
async function fetchJobLog(
  owner: string,
  repo: string,
  jobId: number,
  token: string,
): Promise<Response> {
  const res = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/actions/jobs/${jobId}/logs`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
    redirect: 'manual',
  });
  const location = res.headers.get('Location');
  if (res.status >= 300 && res.status < 400 && location) return fetch(location);
  return res;
}

actionRoutes.get('/actions/job-log', async (c) => {
  const projectId = c.req.query('projectId');
  const jobId = positiveIntParam(c, 'jobId');
  if (!projectId || !jobId) return c.json({ error: 'projectId and jobId are required' }, 400);

  const ctx = await githubRepoFor(c, projectId);
  if (ctx instanceof Response) return ctx;

  try {
    // Not through the cache: a log can be megabytes.
    const res = await fetchJobLog(ctx.owner, ctx.repo, jobId, ctx.token);
    if (res.status === 404 || res.status === 410) {
      return c.json({ error: 'The log is not available (still running or expired)' }, 404);
    }
    if (!res.ok) return upstreamFailure(c, 'job-log', res.status);
    return c.json(extractFailureTail(await res.text()));
  } catch (error: any) {
    return upstreamFailure(c, 'job-log', error);
  }
});

// ── POST /actions/rerun-failed — re-run a run's failed jobs ──────

const rerunBodySchema = z.object({
  projectId: z.string().min(1),
  runId: z.coerce.number().int().positive(),
});

actionRoutes.post('/actions/rerun-failed', async (c) => {
  const parsed = await parseJsonBody(c, rerunBodySchema);
  if (parsed.isErr()) return c.json({ error: 'projectId and runId are required' }, 400);
  const { projectId, runId } = parsed.value;

  const ctx = await githubRepoFor(c, projectId);
  if (ctx instanceof Response) return ctx;

  try {
    const res = await githubApiFetch(
      `/repos/${ctx.owner}/${ctx.repo}/actions/runs/${runId}/rerun-failed-jobs`,
      ctx.token,
      { method: 'POST' },
    );
    if (res.ok) return c.json({ ok: true });
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    const message = body.message || `GitHub API error: ${res.status}`;
    // 403: the token cannot write Actions; 409: the run is still in progress.
    if (res.status === 403 || res.status === 409) return c.json({ error: message }, res.status);
    log.warn('github actions request failed', {
      namespace: 'github-actions',
      action: 'rerun-failed',
      status: res.status,
    });
    return c.json({ error: message }, 502);
  } catch (error: any) {
    return upstreamFailure(c, 'rerun-failed', error);
  }
});
