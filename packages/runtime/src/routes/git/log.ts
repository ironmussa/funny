/**
 * @domain subdomain: Git Operations
 * @domain subdomain-type: supporting
 * @domain type: adapter
 * @domain layer: infrastructure
 */

import {
  getLog,
  getDefaultBranch,
  getGraphLog,
  listBranchRefs,
  getRebaseReflogEvents,
  getUnpushedHashes,
  getCommitBody,
  getCommitFiles,
  getCommitFileDiff,
  getUnpulledHashes,
  type BranchPRInfo,
  type BranchRefTip,
  type GitGraphLogEntry,
  type GraphRef,
} from '@funny/core/git';
import { badRequest, type DomainError } from '@funny/shared/errors';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { err, type Result, type ResultAsync } from 'neverthrow';
import { z } from 'zod';

import { log } from '../../lib/logger.js';
import { requestSpan } from '../../middleware/tracing.js';
import { resolveIdentity, resolveThreadIdentity } from '../../services/git-service.js';
import { wsBroker } from '../../services/ws-broker.js';
import type { HonoEnv } from '../../types/hono-env.js';
import { resultToResponse } from '../../utils/result-response.js';
import { requireThread, steerFromContext } from '../../utils/route-helpers.js';
import { parseQuery, queryBoolean } from '../../validation/request.js';
import { gitRefSchema, validate } from '../../validation/schemas.js';
import { onBothCheckouts, withProjectCheckout, withThreadCheckout } from './checkout-route.js';
import { getCachedPR, getLastKnownPR, requireGitWorkingTree, schedulePRLookup } from './helpers.js';

export const logRoutes = new Hono<HonoEnv>();

// Security (M7): every `/commit/:hash/*` handler passes `:hash` positionally to
// git (`log`, `diff-tree`). Validate it once here so a value such as
// `--output=/tmp/x` can never reach git as an option. Registered before the
// handlers so it runs first for both the project and thread variants.
const validateCommitHashParam: MiddlewareHandler<HonoEnv> = async (c, next) => {
  const parsed = validate(gitRefSchema, c.req.param('hash'));
  if (parsed.isErr()) return resultToResponse(c, parsed);
  return next();
};
logRoutes.use('/project/:projectId/commit/:hash/*', validateCommitHashParam);
logRoutes.use('/:threadId/commit/:hash/*', validateCommitHashParam);

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

function samePR(a: BranchPRInfo | null, b: BranchPRInfo | null): boolean {
  if (!a || !b) return a === b;
  return a.prNumber === b.prNumber && a.prUrl === b.prUrl && a.prState === b.prState;
}

/** Who to tell when a PR looked up after the response changes the graph. */
interface GraphPRAudience {
  userId: string;
  projectId: string;
  /** Empty for the project-scoped graph. */
  threadId: string;
}

/** Hint the client that the graph it was served is missing (or has a stale) PR badge. */
function emitGraphPRChanged({ userId, projectId, threadId }: GraphPRAudience): void {
  wsBroker.emitToUser(userId, {
    type: 'git:refs-updated',
    threadId,
    data: { projectId, changed: ['history'] },
  });
}

/** Branch names of the refs in the graph that may have a PR. */
function graphBranches(entries: GitGraphLogEntry[]): Set<string> {
  const branches = new Set<string>();
  for (const entry of entries) {
    for (const ref of entry.refs) {
      const branch = branchNameForGraphPRLookup(ref);
      if (branch) branches.add(branch);
    }
  }
  return branches;
}

/**
 * The PR to show for a branch right now. A fresh cache entry is used as is; an
 * expired one is shown while a background lookup revalidates it, and a branch
 * never looked up shows none yet. When that lookup answers differently from
 * what was served, the client is told to reload the graph.
 */
function servedPRForBranch(
  cwd: string,
  branch: string,
  ghEnv: Record<string, string> | undefined,
  audience: GraphPRAudience,
): BranchPRInfo | null {
  const fresh = getCachedPR(cwd, branch);
  if (fresh !== undefined) return fresh;
  const served = getLastKnownPR(cwd, branch) ?? null;
  schedulePRLookup({
    projectPath: cwd,
    branch,
    ghEnv,
    onUpdate: (next) => {
      if (!samePR(served, next)) emitGraphPRChanged(audience);
    },
  });
  return served;
}

function withPullRequests(
  entries: GitGraphLogEntry[],
  prByBranch: Map<string, GraphRefPullRequest>,
): GitGraphLogEntry[] {
  return entries.map((entry) => ({
    ...entry,
    refs: entry.refs.map((ref) => {
      const branch = branchNameForGraphPRLookup(ref);
      const pullRequest = branch ? prByBranch.get(branch) : undefined;
      return pullRequest ? { ...ref, pullRequest } : ref;
    }),
  }));
}

/** Annotate branch refs with their PR from the PR cache, never waiting on GitHub. */
async function enrichGraphRefsWithPullRequests(
  c: Context<HonoEnv>,
  cwd: string,
  entries: GitGraphLogEntry[],
  attrs: Record<string, unknown>,
  ghEnv: Record<string, string> | undefined,
  audience: GraphPRAudience,
): Promise<GitGraphLogEntry[]> {
  const branches = graphBranches(entries);
  if (branches.size === 0) return entries;

  const span = requestSpan(c, 'github.graph_log_pr_cache_lookup', {
    ...attrs,
    branchCount: branches.size,
  });

  try {
    const prByBranch = new Map<string, GraphRefPullRequest>();
    for (const branch of branches) {
      const pr = servedPRForBranch(cwd, branch, ghEnv, audience);
      if (pr) prByBranch.set(branch, toGraphRefPullRequest(pr));
    }
    span.end('ok');
    return prByBranch.size === 0 ? entries : withPullRequests(entries, prByBranch);
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

const graphLogFilterSchema = z.object({ hideMerged: queryBoolean.default(false) });

/** The branch a full ref name tracks: `refs/heads/x` → `x`, `refs/remotes/origin/x` → `x`. */
function branchOfFullRef(ref: string): string | null {
  if (ref.startsWith('refs/heads/')) return ref.slice('refs/heads/'.length);
  const remote = /^refs\/remotes\/[^/]+\/(.+)$/.exec(ref);
  return remote ? remote[1] : null;
}

const isMergedPR = (pr: BranchPRInfo | null | undefined): boolean => pr?.prState === 'MERGED';

/**
 * The refs to leave out of the graph when merged branches are hidden:
 * - every ref of a branch whose PR is merged (a squash merge never joins the
 *   base branch, so git alone would keep drawing it as an open lane);
 * - a branch with no PR of its own that points at the same commit as a hidden
 *   ref, e.g. a local branch the issue factory left at the commit it pushed
 *   under another name.
 * `prOf` answers `undefined` for a branch not looked up yet; such a branch
 * stays visible. The base branch is never hidden.
 */
export function refsToHide(
  refs: readonly BranchRefTip[],
  prOf: (branch: string) => BranchPRInfo | null | undefined,
  baseBranch: string | null,
): string[] {
  const hidden = new Set<string>();
  const hiddenTips = new Set<string>();
  for (const { ref, tip } of refs) {
    const branch = branchOfFullRef(ref);
    if (branch === null || branch === baseBranch || !isMergedPR(prOf(branch))) continue;
    hidden.add(ref);
    hiddenTips.add(tip);
  }
  for (const { ref, tip } of refs) {
    const branch = branchOfFullRef(ref);
    if (branch === null || branch === baseBranch || !hiddenTips.has(tip)) continue;
    if (prOf(branch) === null) hidden.add(ref);
  }
  return refs.flatMap(({ ref }) => (hidden.has(ref) ? [ref] : []));
}

/**
 * Refs to leave out of the graph when the user hides merged branches. Uses the
 * last known PR of each branch (like the PR badges), so a merged branch stays
 * hidden after its cache entry expires. Every branch without a fresh answer is
 * looked up in the background, hidden ones included (they are not in the graph,
 * so the badge enrichment never sees them); when a lookup changes whether a
 * branch counts as merged, the client is told to reload the graph.
 */
async function mergedBranchRefs(
  c: Context<HonoEnv>,
  cwd: string,
  ghEnv: Record<string, string> | undefined,
  audience: GraphPRAudience,
): Promise<string[]> {
  const query = parseQuery(c, graphLogFilterSchema);
  if (query.isErr() || !query.value.hideMerged) return [];
  const [refs, baseBranch] = await Promise.all([listBranchRefs(cwd), getDefaultBranch(cwd)]);
  if (refs.isErr()) return [];
  const served = new Map<string, BranchPRInfo | null | undefined>();
  for (const { ref } of refs.value) {
    const branch = branchOfFullRef(ref);
    if (branch === null || served.has(branch)) continue;
    const known = getLastKnownPR(cwd, branch);
    served.set(branch, known);
    if (getCachedPR(cwd, branch) !== undefined) continue;
    schedulePRLookup({
      projectPath: cwd,
      branch,
      ghEnv,
      onUpdate: (next) => {
        if (isMergedPR(next) !== isMergedPR(known)) emitGraphPRChanged(audience);
      },
    });
  }
  return refsToHide(
    refs.value,
    (branch) => served.get(branch),
    baseBranch.isOk() ? baseBranch.value : null,
  );
}

// ─── Log and graph-log, shared by the project and thread routes ───────────

type LogIds = { projectId: string } | { threadId: string };

const githubEnvOf = (identity: { githubToken?: string } | undefined) =>
  identity?.githubToken ? { GH_TOKEN: identity.githubToken } : undefined;

/** The paged log of `cwd` (from `baseBranch` when given) with its unpushed/unpulled marks. */
async function answerLog(
  c: Context<HonoEnv>,
  cwd: string,
  ids: LogIds,
  baseBranch: string | null | undefined,
): Promise<Response> {
  const { limit, skip } = parseLogPaging(c);
  const [result, unpushedSet, unpulledSet] = await Promise.all([
    fetchLogSpanned(c, 'git.log', ids, () => getLog(cwd, limit + 1, baseBranch, skip)),
    fetchUnpushedSpanned(c, cwd, ids),
    fetchUnpulledSpanned(c, cwd, ids),
  ]);
  return respondWithLog(c, result, unpushedSet, unpulledSet, limit);
}

/** The topology-aware log of `cwd`, its branch refs annotated with their cached PRs. */
async function answerGraphLog(
  c: Context<HonoEnv>,
  cwd: string,
  ids: LogIds,
  ghEnv: Record<string, string> | undefined,
  audience: GraphPRAudience,
): Promise<Response> {
  const { limit, skip } = parseLogPaging(c);
  // Graph view defaults to all refs so divergent branches show; opt out with all=false.
  const all = c.req.query('all') !== 'false';
  const excludeRefs = await mergedBranchRefs(c, cwd, ghEnv, audience);
  const [result, unpushedSet, unpulledSet] = await Promise.all([
    fetchLogSpanned(c, 'git.graph_log', ids, () =>
      getGraphLog(cwd, { limit: limit + 1, skip, all, excludeRefs }),
    ),
    fetchUnpushedSpanned(c, cwd, ids),
    fetchUnpulledSpanned(c, cwd, ids),
  ]);
  if (result.isErr()) return respondWithLog(c, result, unpushedSet, unpulledSet, limit);
  const payload = buildLogPayload(result.value, unpushedSet, unpulledSet, limit);
  const entries = await enrichGraphRefsWithPullRequests(
    c,
    cwd,
    payload.entries,
    ids,
    ghEnv,
    audience,
  );
  return c.json({ ...payload, entries });
}

// ─── Project-scoped routes ──────────────────────────────

// GET /api/git/project/:projectId/log
logRoutes.get('/project/:projectId/log', (c) =>
  withProjectCheckout(c, async ({ projectId, cwd }) => {
    const workTreeResult = await requireGitWorkingTree(cwd);
    if (workTreeResult.isErr()) return resultToResponse(c, workTreeResult);
    return answerLog(c, cwd, { projectId }, undefined);
  }),
);

// GET /api/git/project/:projectId/graph-log — topology-aware log (parents + refs)
logRoutes.get('/project/:projectId/graph-log', (c) =>
  withProjectCheckout(c, async ({ projectId, userId, cwd }) => {
    const workTreeResult = await requireGitWorkingTree(cwd);
    if (workTreeResult.isErr()) return resultToResponse(c, workTreeResult);
    const ghEnv = githubEnvOf(await resolveIdentity(userId, projectId));
    return answerGraphLog(c, cwd, { projectId }, ghEnv, { userId, projectId, threadId: '' });
  }),
);

// ─── Thread-scoped routes (on the steer allow-list) ─────

// GET /api/git/:threadId/log
logRoutes.get('/:threadId/log', (c) =>
  withThreadCheckout(
    c,
    async ({ threadId, userId, cwd }) => {
      const thread = await requireThread(threadId, userId, steerFromContext(c));
      if (thread.isErr()) return resultToResponse(c, thread);
      const workTreeResult = await requireGitWorkingTree(cwd);
      if (workTreeResult.isErr()) return resultToResponse(c, workTreeResult);
      const all = c.req.query('all') === 'true';
      return answerLog(c, cwd, { threadId }, all ? undefined : thread.value.baseBranch);
    },
    { steerable: true },
  ),
);

// GET /api/git/:threadId/graph-log — topology-aware log (parents + refs)
logRoutes.get('/:threadId/graph-log', (c) =>
  withThreadCheckout(
    c,
    async ({ threadId, userId, cwd }) => {
      const thread = await requireThread(threadId, userId, steerFromContext(c));
      if (thread.isErr()) return resultToResponse(c, thread);
      const workTreeResult = await requireGitWorkingTree(cwd);
      if (workTreeResult.isErr()) return resultToResponse(c, workTreeResult);
      const ghEnv = githubEnvOf(await resolveThreadIdentity(userId, threadId));
      const audience = { userId, projectId: thread.value.projectId, threadId };
      return answerGraphLog(c, cwd, { threadId }, ghEnv, audience);
    },
    { steerable: true },
  ),
);

// ─── Commit reads, the same on a project and on a thread checkout ───────────

const commitHash = (c: Context<HonoEnv>) => c.req.param('hash') ?? '';

// GET /api/git/(project/:projectId | :threadId)/reflog-events — local rebase operation markers
onBothCheckouts(
  logRoutes,
  'GET',
  '/reflog-events',
  async (c, { cwd, ids }) => {
    const result = await fetchLogSpanned(c, 'git.reflog_events', ids, () =>
      getRebaseReflogEvents(cwd),
    );
    if (result.isErr()) return resultToResponse(c, result);
    return c.json({ events: result.value });
  },
  { steerable: true },
);

// GET /api/git/(project/:projectId | :threadId)/commit/:hash/files
onBothCheckouts(
  logRoutes,
  'GET',
  '/commit/:hash/files',
  async (c, { cwd, ids }) => {
    const hash = commitHash(c);
    const result = await fetchLogSpanned(c, 'git.commit_files', { ...ids, hash }, () =>
      getCommitFiles(cwd, hash),
    );
    if (result.isErr()) return resultToResponse(c, result);
    return c.json({ files: result.value });
  },
  { steerable: true },
);

// GET /api/git/(project/:projectId | :threadId)/commit/:hash/diff
onBothCheckouts(
  logRoutes,
  'GET',
  '/commit/:hash/diff',
  async (c, { cwd, ids }) => {
    const filePath = c.req.query('path');
    if (!filePath) {
      return resultToResponse(c, err(badRequest('Missing required query parameter: path')));
    }
    const hash = commitHash(c);
    const result = await fetchLogSpanned(
      c,
      'git.commit_diff',
      { ...ids, hash, path: filePath },
      () => getCommitFileDiff(cwd, hash, filePath),
    );
    if (result.isErr()) return resultToResponse(c, result);
    return c.json({ diff: result.value });
  },
  { steerable: true },
);

// GET /api/git/(project/:projectId | :threadId)/commit/:hash/body
onBothCheckouts(
  logRoutes,
  'GET',
  '/commit/:hash/body',
  async (c, { cwd, ids }) => {
    const hash = commitHash(c);
    const result = await fetchLogSpanned(c, 'git.commit_body', { ...ids, hash }, () =>
      getCommitBody(cwd, hash),
    );
    if (result.isErr()) return resultToResponse(c, result);
    return c.json({ body: result.value });
  },
  { steerable: true },
);
