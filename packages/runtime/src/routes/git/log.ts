/**
 * @domain subdomain: Git Operations
 * @domain subdomain-type: supporting
 * @domain type: adapter
 * @domain layer: infrastructure
 */

import {
  getLog,
  getGraphLog,
  getRebaseReflogEvents,
  getUnpushedHashes,
  getCommitBody,
  getCommitFiles,
  getCommitFileDiff,
  getUnpulledHashes,
  type BranchPRInfo,
  type GitGraphLogEntry,
  type GraphRef,
} from '@funny/core/git';
import { badRequest, type DomainError } from '@funny/shared/errors';
import { Hono, type Context } from 'hono';
import { err, type Result, type ResultAsync } from 'neverthrow';

import { log } from '../../lib/logger.js';
import { requestSpan } from '../../middleware/tracing.js';
import { resolveIdentity } from '../../services/git-service.js';
import type { HonoEnv } from '../../types/hono-env.js';
import { resultToResponse } from '../../utils/result-response.js';
import { requireThread, requireThreadCwd, steerFromContext } from '../../utils/route-helpers.js';
import {
  getCachedPR,
  requireGitWorkingTree,
  requireProjectCwd,
  schedulePRLookup,
} from './helpers.js';

export const logRoutes = new Hono<HonoEnv>();

// ─── Shared helpers ─────────────────────────────────────
// The project-scoped and thread-scoped log endpoints are structurally
// identical — only the cwd resolver (and, for the flat log, the baseBranch)
// differ. These helpers hold the parsing, tracing, and response-shaping logic
// so the handlers below stay thin and the response shape lives in one place.

/**
 * Pure paging parse: `limit` defaults to 50 and is capped at 200; an unparseable
 * value falls back to 20. `skip` defaults to 0 and is floored at 0. Exported for
 * unit testing — handlers use {@link parseLogPaging} which reads the query string.
 */
export function parseLogPagingFrom(
  limitRaw: string | undefined,
  skipRaw: string | undefined,
): { limit: number; skip: number } {
  const limit = limitRaw ? Math.min(parseInt(limitRaw, 10) || 20, 200) : 50;
  const skip = skipRaw ? Math.max(parseInt(skipRaw, 10) || 0, 0) : 0;
  return { limit, skip };
}

/** Parse the shared `limit` and `skip` query params off a request context. */
function parseLogPaging(c: Context<HonoEnv>): { limit: number; skip: number } {
  return parseLogPagingFrom(c.req.query('limit'), c.req.query('skip'));
}

/**
 * Pure response shaping. The fetch over-reads by one entry (`limit + 1`) so we
 * can report `hasMore` without a second query; this trims that look-ahead entry
 * and projects the unpushed hashes that fall within the returned window. Exported
 * for unit testing — handlers use {@link respondWithLog} which wraps this in `c.json`.
 */
export function buildLogPayload<E extends { hash: string }>(
  entries: E[],
  unpushedSet: Set<string>,
  unpulledSet: Set<string>,
  limit: number,
): {
  entries: E[];
  hasMore: boolean;
  unpushedHashes: string[];
  unpulledHashes: string[];
} {
  const hasMore = entries.length > limit;
  const trimmed = hasMore ? entries.slice(0, limit) : entries;
  const unpushedHashes = trimmed.filter((e) => unpushedSet.has(e.hash)).map((e) => e.hash);
  const unpulledHashes = trimmed.filter((e) => unpulledSet.has(e.hash)).map((e) => e.hash);
  return { entries: trimmed, hasMore, unpushedHashes, unpulledHashes };
}

/** Run a Result-returning log fetch inside a request span, recording ok/error on the span. */
async function fetchLogSpanned<T>(
  c: Context<HonoEnv>,
  spanName: string,
  attrs: Record<string, unknown>,
  run: () => ResultAsync<T, DomainError>,
): Promise<Result<T, DomainError>> {
  const span = requestSpan(c, spanName, attrs);
  const r = await run();
  span.end(r.isOk() ? 'ok' : 'error', r.isErr() ? r.error.message : undefined);
  return r;
}

/**
 * Fetch the set of unpushed commit hashes inside a request span. The unpushed
 * badges are accessory to the log, so a failure degrades to an empty set rather
 * than failing the whole request — but we log the failure (per the Abbacchio
 * logging policy) so a recurring degradation isn't silently invisible.
 */
async function fetchUnpushedSpanned(
  c: Context<HonoEnv>,
  cwd: string,
  attrs: Record<string, unknown>,
): Promise<Set<string>> {
  const span = requestSpan(c, 'git.unpushed_hashes', attrs);
  const r = await getUnpushedHashes(cwd);
  span.end(r.isOk() ? 'ok' : 'error', r.isErr() ? r.error.message : undefined);
  if (r.isErr()) {
    log.warn('getUnpushedHashes failed; treating as no unpushed commits', {
      namespace: 'git-log-route',
      error: r.error.message,
      ...attrs,
    });
    return new Set<string>();
  }
  return r.value;
}

/**
 * Fetch the set of incoming commit hashes inside a request span. Like unpushed
 * badges, this is accessory metadata and degrades to an empty set on failure.
 */
async function fetchUnpulledSpanned(
  c: Context<HonoEnv>,
  cwd: string,
  attrs: Record<string, unknown>,
): Promise<Set<string>> {
  const span = requestSpan(c, 'git.unpulled_hashes', attrs);
  const r = await getUnpulledHashes(cwd);
  span.end(r.isOk() ? 'ok' : 'error', r.isErr() ? r.error.message : undefined);
  if (r.isErr()) {
    log.warn('getUnpulledHashes failed; treating as no unpulled commits', {
      namespace: 'git-log-route',
      error: r.error.message,
      ...attrs,
    });
    return new Set<string>();
  }
  return r.value;
}

/** Send the shared log response, or convert an upstream error into an HTTP response. */
function respondWithLog<E extends { hash: string }>(
  c: Context<HonoEnv>,
  result: Result<E[], DomainError>,
  unpushedSet: Set<string>,
  unpulledSet: Set<string>,
  limit: number,
) {
  if (result.isErr()) return resultToResponse(c, result);
  return c.json(buildLogPayload(result.value, unpushedSet, unpulledSet, limit));
}

type GraphRefPullRequest = NonNullable<GraphRef['pullRequest']>;

function branchNameForGraphPRLookup(ref: GraphRef | string): string | null {
  if (typeof ref === 'string') return null;
  if (ref.kind === 'tag' || ref.name === 'HEAD') return null;
  if (ref.kind === 'local') return ref.name;
  const slashIndex = ref.name.indexOf('/');
  return slashIndex >= 0 ? ref.name.slice(slashIndex + 1) : ref.name;
}

function toGraphRefPullRequest(pr: BranchPRInfo): GraphRefPullRequest {
  return {
    number: pr.prNumber,
    url: pr.prUrl,
    state: pr.prState,
  };
}

async function enrichGraphRefsWithPullRequests(
  c: Context<HonoEnv>,
  cwd: string,
  entries: GitGraphLogEntry[],
  attrs: Record<string, unknown>,
  ghEnv: Record<string, string> | undefined,
): Promise<GitGraphLogEntry[]> {
  const branches = new Set<string>();
  for (const entry of entries) {
    for (const ref of entry.refs) {
      const branch = branchNameForGraphPRLookup(ref);
      if (branch) branches.add(branch);
    }
  }
  if (branches.size === 0) return entries;

  const span = requestSpan(c, 'github.graph_log_pr_cache_lookup', {
    ...attrs,
    branchCount: branches.size,
  });

  try {
    const prByBranch = new Map<string, GraphRefPullRequest>();
    for (const branch of branches) {
      const pr = getCachedPR(cwd, branch);
      if (pr === undefined) {
        schedulePRLookup({ projectPath: cwd, branch, ghEnv });
      } else if (pr) {
        prByBranch.set(branch, toGraphRefPullRequest(pr));
      }
    }
    span.end('ok');
    if (prByBranch.size === 0) return entries;

    return entries.map((entry) => ({
      ...entry,
      refs: entry.refs.map((ref) => {
        const branch = branchNameForGraphPRLookup(ref);
        const pullRequest = branch ? prByBranch.get(branch) : undefined;
        return pullRequest ? { ...ref, pullRequest } : ref;
      }),
    }));
  } catch (error) {
    span.end('error', String(error));
    log.warn('graph-log PR lookup failed; returning refs without PR metadata', {
      namespace: 'git-log-route',
      error: String(error),
      ...attrs,
    });
    return entries;
  }
}

// ─── Project-scoped routes ──────────────────────────────

// GET /api/git/project/:projectId/log
logRoutes.get('/project/:projectId/log', async (c) => {
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const projectId = c.req.param('projectId');
  const cwdResult = await requireProjectCwd(projectId, userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const cwd = cwdResult.value;
  const workTreeResult = await requireGitWorkingTree(cwd);
  if (workTreeResult.isErr()) return resultToResponse(c, workTreeResult);
  const { limit, skip } = parseLogPaging(c);
  const [result, unpushedSet, unpulledSet] = await Promise.all([
    fetchLogSpanned(c, 'git.log', { projectId }, () => getLog(cwd, limit + 1, undefined, skip)),
    fetchUnpushedSpanned(c, cwd, { projectId }),
    fetchUnpulledSpanned(c, cwd, { projectId }),
  ]);
  return respondWithLog(c, result, unpushedSet, unpulledSet, limit);
});

// GET /api/git/project/:projectId/graph-log — topology-aware log (parents + refs)
logRoutes.get('/project/:projectId/graph-log', async (c) => {
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const projectId = c.req.param('projectId');
  const cwdResult = await requireProjectCwd(projectId, userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const cwd = cwdResult.value;
  const workTreeResult = await requireGitWorkingTree(cwd);
  if (workTreeResult.isErr()) return resultToResponse(c, workTreeResult);
  const { limit, skip } = parseLogPaging(c);
  const all = c.req.query('all') !== 'false';
  const identity = await resolveIdentity(userId);
  const ghEnv = identity?.githubToken ? { GH_TOKEN: identity.githubToken } : undefined;
  const [result, unpushedSet, unpulledSet] = await Promise.all([
    fetchLogSpanned(c, 'git.graph_log', { projectId }, () =>
      getGraphLog(cwd, { limit: limit + 1, skip, all }),
    ),
    fetchUnpushedSpanned(c, cwd, { projectId }),
    fetchUnpulledSpanned(c, cwd, { projectId }),
  ]);
  if (result.isErr()) return respondWithLog(c, result, unpushedSet, unpulledSet, limit);
  const payload = buildLogPayload(result.value, unpushedSet, unpulledSet, limit);
  const entries = await enrichGraphRefsWithPullRequests(
    c,
    cwd,
    payload.entries,
    { projectId },
    ghEnv,
  );
  return c.json({ ...payload, entries });
});

// GET /api/git/project/:projectId/reflog-events — local rebase operation markers
logRoutes.get('/project/:projectId/reflog-events', async (c) => {
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const projectId = c.req.param('projectId');
  const cwdResult = await requireProjectCwd(projectId, userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const result = await fetchLogSpanned(c, 'git.reflog_events', { projectId }, () =>
    getRebaseReflogEvents(cwdResult.value),
  );
  if (result.isErr()) return resultToResponse(c, result);
  return c.json({ events: result.value });
});

// GET /api/git/project/:projectId/commit/:hash/files
logRoutes.get('/project/:projectId/commit/:hash/files', async (c) => {
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireProjectCwd(c.req.param('projectId'), userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const result = await fetchLogSpanned(
    c,
    'git.commit_files',
    { projectId: c.req.param('projectId'), hash: c.req.param('hash') },
    () => getCommitFiles(cwdResult.value, c.req.param('hash')),
  );
  if (result.isErr()) return resultToResponse(c, result);
  return c.json({ files: result.value });
});

// GET /api/git/project/:projectId/commit/:hash/diff
logRoutes.get('/project/:projectId/commit/:hash/diff', async (c) => {
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireProjectCwd(c.req.param('projectId'), userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const filePath = c.req.query('path');
  if (!filePath) {
    return resultToResponse(c, err(badRequest('Missing required query parameter: path')));
  }
  const result = await fetchLogSpanned(
    c,
    'git.commit_diff',
    {
      projectId: c.req.param('projectId'),
      hash: c.req.param('hash'),
      path: filePath,
    },
    () => getCommitFileDiff(cwdResult.value, c.req.param('hash'), filePath),
  );
  if (result.isErr()) return resultToResponse(c, result);
  return c.json({ diff: result.value });
});

// GET /api/git/project/:projectId/commit/:hash/body
logRoutes.get('/project/:projectId/commit/:hash/body', async (c) => {
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireProjectCwd(c.req.param('projectId'), userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const result = await fetchLogSpanned(
    c,
    'git.commit_body',
    { projectId: c.req.param('projectId'), hash: c.req.param('hash') },
    () => getCommitBody(cwdResult.value, c.req.param('hash')),
  );
  if (result.isErr()) return resultToResponse(c, result);
  return c.json({ body: result.value });
});

// ─── Thread-scoped routes ───────────────────────────────

// GET /api/git/:threadId/log
logRoutes.get('/:threadId/log', async (c) => {
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const threadId = c.req.param('threadId');
  const steer = steerFromContext(c);
  const threadResult = await requireThread(threadId, userId, orgId, steer);
  if (threadResult.isErr()) return resultToResponse(c, threadResult);
  const thread = threadResult.value;

  const cwdResult = await requireThreadCwd(threadId, userId, orgId, steer);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const cwd = cwdResult.value;
  const workTreeResult = await requireGitWorkingTree(cwd);
  if (workTreeResult.isErr()) return resultToResponse(c, workTreeResult);

  const { limit, skip } = parseLogPaging(c);
  const all = c.req.query('all') === 'true';
  const baseBranch = all ? undefined : thread.baseBranch;
  const [result, unpushedSet, unpulledSet] = await Promise.all([
    fetchLogSpanned(c, 'git.log', { threadId }, () => getLog(cwd, limit + 1, baseBranch, skip)),
    fetchUnpushedSpanned(c, cwd, { threadId }),
    fetchUnpulledSpanned(c, cwd, { threadId }),
  ]);
  return respondWithLog(c, result, unpushedSet, unpulledSet, limit);
});

// GET /api/git/:threadId/graph-log — topology-aware log (parents + refs)
logRoutes.get('/:threadId/graph-log', async (c) => {
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const threadId = c.req.param('threadId');
  const steer = steerFromContext(c);
  const threadResult = await requireThread(threadId, userId, orgId, steer);
  if (threadResult.isErr()) return resultToResponse(c, threadResult);

  const cwdResult = await requireThreadCwd(threadId, userId, orgId, steer);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const cwd = cwdResult.value;
  const workTreeResult = await requireGitWorkingTree(cwd);
  if (workTreeResult.isErr()) return resultToResponse(c, workTreeResult);

  const { limit, skip } = parseLogPaging(c);
  // Graph view defaults to all refs so divergent branches show; opt out with all=false.
  const all = c.req.query('all') !== 'false';
  const identity = await resolveIdentity(userId);
  const ghEnv = identity?.githubToken ? { GH_TOKEN: identity.githubToken } : undefined;
  const [result, unpushedSet, unpulledSet] = await Promise.all([
    fetchLogSpanned(c, 'git.graph_log', { threadId }, () =>
      getGraphLog(cwd, { limit: limit + 1, skip, all }),
    ),
    fetchUnpushedSpanned(c, cwd, { threadId }),
    fetchUnpulledSpanned(c, cwd, { threadId }),
  ]);
  if (result.isErr()) return respondWithLog(c, result, unpushedSet, unpulledSet, limit);
  const payload = buildLogPayload(result.value, unpushedSet, unpulledSet, limit);
  const entries = await enrichGraphRefsWithPullRequests(
    c,
    cwd,
    payload.entries,
    { threadId },
    ghEnv,
  );
  return c.json({ ...payload, entries });
});

// GET /api/git/:threadId/reflog-events — local rebase operation markers
logRoutes.get('/:threadId/reflog-events', async (c) => {
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const threadId = c.req.param('threadId');
  const steer = steerFromContext(c);
  const threadResult = await requireThread(threadId, userId, orgId, steer);
  if (threadResult.isErr()) return resultToResponse(c, threadResult);

  const cwdResult = await requireThreadCwd(threadId, userId, orgId, steer);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const result = await fetchLogSpanned(c, 'git.reflog_events', { threadId }, () =>
    getRebaseReflogEvents(cwdResult.value),
  );
  if (result.isErr()) return resultToResponse(c, result);
  return c.json({ events: result.value });
});

// GET /api/git/:threadId/commit/:hash/files
logRoutes.get('/:threadId/commit/:hash/files', async (c) => {
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireThreadCwd(
    c.req.param('threadId'),
    userId,
    orgId,
    steerFromContext(c),
  );
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const result = await fetchLogSpanned(
    c,
    'git.commit_files',
    { threadId: c.req.param('threadId'), hash: c.req.param('hash') },
    () => getCommitFiles(cwdResult.value, c.req.param('hash')),
  );
  if (result.isErr()) return resultToResponse(c, result);
  return c.json({ files: result.value });
});

// GET /api/git/:threadId/commit/:hash/diff
logRoutes.get('/:threadId/commit/:hash/diff', async (c) => {
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireThreadCwd(
    c.req.param('threadId'),
    userId,
    orgId,
    steerFromContext(c),
  );
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const filePath = c.req.query('path');
  if (!filePath) {
    return resultToResponse(c, err(badRequest('Missing required query parameter: path')));
  }
  const result = await fetchLogSpanned(
    c,
    'git.commit_diff',
    {
      threadId: c.req.param('threadId'),
      hash: c.req.param('hash'),
      path: filePath,
    },
    () => getCommitFileDiff(cwdResult.value, c.req.param('hash'), filePath),
  );
  if (result.isErr()) return resultToResponse(c, result);
  return c.json({ diff: result.value });
});

// GET /api/git/:threadId/commit/:hash/body
logRoutes.get('/:threadId/commit/:hash/body', async (c) => {
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireThreadCwd(
    c.req.param('threadId'),
    userId,
    orgId,
    steerFromContext(c),
  );
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const result = await fetchLogSpanned(
    c,
    'git.commit_body',
    { threadId: c.req.param('threadId'), hash: c.req.param('hash') },
    () => getCommitBody(cwdResult.value, c.req.param('hash')),
  );
  if (result.isErr()) return resultToResponse(c, result);
  return c.json({ body: result.value });
});
