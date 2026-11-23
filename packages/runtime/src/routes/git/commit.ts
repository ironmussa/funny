/**
 * @domain subdomain: Git Operations
 * @domain subdomain-type: supporting
 * @domain type: adapter
 * @domain layer: infrastructure
 */

import { getDiff, addToGitignore, commit, runHookCommand, gitRead } from '@funny/core/git';
import type { FileDiff } from '@funny/shared';
import { badRequest, internal, type DomainError } from '@funny/shared/errors';
import { Hono, type Context } from 'hono';
import { err, ok, type Result } from 'neverthrow';

import { log } from '../../lib/logger.js';
import { requestSpan } from '../../middleware/tracing.js';
import { generateCommitMessage } from '../../services/commit-message-generator.js';
import { commitChanges as gitServiceCommit, resolveIdentity } from '../../services/git-service.js';
import { getPipelineForProject } from '../../services/pipeline-manager.js';
import { buildCommitMessagePrompt } from '../../services/pipeline-prompts.js';
import { listHooks } from '../../services/project-hooks-service.js';
import * as tm from '../../services/thread-manager.js';
import type { HonoEnv } from '../../types/hono-env.js';
import { resultToResponse } from '../../utils/result-response.js';
import { requireThread, requireThreadCwd, requireProject } from '../../utils/route-helpers.js';
import { readBody } from '../../validation/request.js';
import {
  validate,
  commitSchema,
  generateCommitMessageSchema,
  gitignoreSchema,
  runHookCommandSchema,
} from '../../validation/schemas.js';
import { withProjectCheckout, withThreadCheckout } from './checkout-route.js';
import { gitStatusCache, invalidateGitStatusCache } from './helpers.js';

export const commitRoutes = new Hono<HonoEnv>();

// POST /api/git/project/:projectId/commit
commitRoutes.post('/project/:projectId/commit', (c) =>
  withProjectCheckout(c, async ({ projectId, userId, cwd }) => {
    const parsed = await readBody(c, commitSchema);
    if (parsed.isErr()) return resultToResponse(c, parsed);
    const identity = await resolveIdentity(userId, projectId);
    const result = await commit(
      cwd,
      parsed.value.message,
      identity,
      parsed.value.amend,
      parsed.value.noVerify,
    );
    if (result.isErr()) return resultToResponse(c, result);
    gitStatusCache.delete(projectId);
    // Best-effort SHA capture for scheduler / automation consumers.
    const sha = await gitRead(['rev-parse', 'HEAD'], { cwd, reject: false })
      .then((r) => (r.exitCode === 0 ? r.stdout.trim() : undefined))
      .catch(() => undefined);
    return c.json({ ok: true, output: result.value, sha });
  }),
);

// POST /api/git/project/:projectId/run-hook-command
// Runs a single pre-commit hook command by index for per-hook progress tracking
commitRoutes.post('/project/:projectId/run-hook-command', (c) =>
  withProjectCheckout(c, async ({ cwd }) => {
    const parsed = await readBody(c, runHookCommandSchema);
    if (parsed.isErr()) return resultToResponse(c, parsed);
    const { hookIndex } = parsed.value;
    const hooks = listHooks(cwd, 'pre-commit').filter((h) => h.enabled);
    if (hookIndex >= hooks.length) {
      return resultToResponse(c, err(badRequest(`Invalid hookIndex: ${hookIndex}`)));
    }
    const hookResult = await runHookCommand(cwd, hooks[hookIndex].command);
    if (hookResult.isErr()) return resultToResponse(c, hookResult);
    return c.json(hookResult.value);
  }),
);

// POST /api/git/project/:projectId/generate-commit-message
commitRoutes.post('/project/:projectId/generate-commit-message', (c) =>
  withProjectCheckout(c, ({ projectId, cwd }) => answerCommitMessage(c, cwd, projectId)),
);

// POST /api/git/project/:projectId/gitignore
commitRoutes.post('/project/:projectId/gitignore', (c) =>
  withProjectCheckout(c, async ({ cwd }) => {
    const parsed = await readBody(c, gitignoreSchema);
    if (parsed.isErr()) return resultToResponse(c, parsed);
    for (const p of parsed.value) {
      const result = addToGitignore(cwd, p);
      if (result.isErr()) return resultToResponse(c, result);
    }
    return c.json({ ok: true });
  }),
);

// POST /api/git/:threadId/commit
commitRoutes.post('/:threadId/commit', (c) =>
  withThreadCheckout(c, async ({ threadId, userId, cwd }) => {
    const parsed = await readBody(c, commitSchema);
    if (parsed.isErr()) return resultToResponse(c, parsed);

    const span = requestSpan(c, 'git.commit', { threadId });
    const result = await gitServiceCommit(
      threadId,
      userId,
      cwd,
      parsed.value.message,
      parsed.value.amend,
      parsed.value.noVerify,
    );
    if (result.isErr()) {
      span.end('error', result.error.message);
      return resultToResponse(c, result);
    }
    await invalidateGitStatusCache(threadId);
    span.end('ok');
    return c.json({ ok: true, output: result.value.output, sha: result.value.sha });
  }),
);

// POST /api/git/:threadId/run-hook-command
// Runs a single pre-commit hook command by index for per-hook progress tracking
commitRoutes.post('/:threadId/run-hook-command', (c) =>
  withThreadCheckout(c, async ({ threadId, userId, cwd }) => {
    const orgId = c.get('organizationId');
    const parsed = await readBody(c, runHookCommandSchema);
    if (parsed.isErr()) return resultToResponse(c, parsed);
    const { hookIndex } = parsed.value;
    // Look up the project path for hook config (worktree cwd may differ from project root)
    const thread = await tm.getThread(threadId);
    const projectId = thread?.projectId;
    let hookCwd = cwd;
    if (projectId) {
      const project = await requireProject(projectId, userId, orgId);
      if (project.isOk()) hookCwd = project.value.path;
    }
    const hooks = listHooks(hookCwd, 'pre-commit').filter((h) => h.enabled);
    if (hookIndex >= hooks.length) {
      return resultToResponse(c, err(badRequest(`Invalid hookIndex: ${hookIndex}`)));
    }
    // Run the hook command in the thread's working directory (not the project root)
    const hookResult = await runHookCommand(cwd, hooks[hookIndex].command);
    if (hookResult.isErr()) return resultToResponse(c, hookResult);
    return c.json(hookResult.value);
  }),
);

// POST /api/git/:threadId/generate-commit-message
commitRoutes.post('/:threadId/generate-commit-message', (c) =>
  withThreadCheckout(c, async ({ threadId, userId, cwd }) => {
    const thread = await requireThread(threadId, userId);
    if (thread.isErr()) return resultToResponse(c, thread);
    return answerCommitMessage(c, cwd, thread.value.projectId);
  }),
);

// POST /api/git/:threadId/gitignore
commitRoutes.post('/:threadId/gitignore', async (c) => {
  const userId = c.get('userId');
  const cwdResult = await requireThreadCwd(c.req.param('threadId'), userId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const cwd = cwdResult.value;

  const raw = await c.req.json().catch(() => ({}));
  const parsed = validate(gitignoreSchema, raw);
  if (parsed.isErr()) return resultToResponse(c, parsed);
  for (const p of parsed.value) {
    const result = addToGitignore(cwd, p);
    if (result.isErr()) return resultToResponse(c, result);
  }
  return c.json({ ok: true });
});

// ── Commit message generation (shared by the project and thread routes) ────

const MAX_DIFF_LEN = 20_000;

/** Model output that is an authentication failure, not a commit message. */
const AUTH_ERROR_PATTERNS = [
  /invalid api key/i,
  /authentication.*error/i,
  /fix external api key/i,
  /unauthorized/i,
  /api key.*invalid/i,
];

interface CommitMessage {
  title: string;
  body: string;
}

/** Generates a commit message for the checkout's changes and answers `{ title, body }`. */
async function answerCommitMessage(
  c: Context<HonoEnv>,
  cwd: string,
  projectId: string,
): Promise<Response> {
  const diffs = await changesToDescribe(c, cwd);
  if (diffs.isErr()) return resultToResponse(c, diffs);
  return resultToResponse(c, await writeCommitMessage(c, cwd, projectId, diffs.value));
}

/** The diffs to describe: the staged ones, or every change with `includeUnstaged`. */
async function changesToDescribe(
  c: Context<HonoEnv>,
  cwd: string,
): Promise<Result<FileDiff[], DomainError>> {
  const parsed = await readBody(c, generateCommitMessageSchema);
  if (parsed.isErr()) return err(parsed.error);
  const includeUnstaged = parsed.value.includeUnstaged === true;
  return (await getDiff(cwd)).andThen((diffs) =>
    nonEmpty(includeUnstaged ? diffs : diffs.filter((d) => d.staged)),
  );
}

function nonEmpty(diffs: FileDiff[]): Result<FileDiff[], DomainError> {
  return diffs.length === 0
    ? err(badRequest('No files to generate a commit message for'))
    : ok(diffs);
}

async function writeCommitMessage(
  c: Context<HonoEnv>,
  cwd: string,
  projectId: string,
  diffs: FileDiff[],
): Promise<Result<CommitMessage, DomainError>> {
  const diffSummary = summarizeDiffs(diffs);
  const pipelineCfg = await getPipelineForProject(projectId);
  const prompt = buildCommitMessagePrompt(diffSummary, pipelineCfg?.commitMessagePrompt);
  const span = requestSpan(c, 'ai.generate_commit_message', {
    diffLength: diffSummary.length,
    fileCount: diffs.length,
  });
  const output = await generateCommitMessage({ cwd, prompt, signal: c.req.raw.signal });
  if ('error' in output) {
    span.end('error', output.error);
    return err(internal(output.error));
  }
  span.end('ok');
  return parseCommitMessage(output.text);
}

/** The diffs as prompt text, truncated to MAX_DIFF_LEN. */
function summarizeDiffs(diffs: FileDiff[]): string {
  const summary = diffs
    .map((d) => `--- ${d.status}: ${d.path} ---\n${d.diff || '(no diff)'}`)
    .join('\n\n');
  return summary.length > MAX_DIFF_LEN
    ? summary.slice(0, MAX_DIFF_LEN) + '\n\n... (diff truncated for length)'
    : summary;
}

/** The `TITLE:` and `BODY:` in the model's output, or why the output is not a commit message. */
function parseCommitMessage(text: string): Result<CommitMessage, DomainError> {
  const trimmed = text.trim();
  if (AUTH_ERROR_PATTERNS.some((p) => p.test(trimmed))) {
    log.error('SDK auth error generating commit message', {
      namespace: 'git',
      output: trimmed.slice(0, 200),
    });
    return err(internal(trimmed.split('\n')[0]));
  }
  const titleMatch = trimmed.match(/^TITLE:\s*(.+)/m);
  if (!titleMatch) {
    log.error('Unexpected output from commit message generation', {
      namespace: 'git',
      output: trimmed.slice(0, 500),
    });
    return err(internal('Failed to generate commit message'));
  }
  return ok({ title: titleMatch[1].trim(), body: commitBodyOf(trimmed) });
}

function commitBodyOf(text: string): string {
  return text.match(/^BODY:\s*([\s\S]+)/m)?.[1]?.trim() || '';
}
