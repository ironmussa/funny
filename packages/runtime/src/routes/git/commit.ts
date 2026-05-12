/**
 * @domain subdomain: Git Operations
 * @domain subdomain-type: supporting
 * @domain type: adapter
 * @domain layer: infrastructure
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import { resolveSDKCliPath } from '@funny/core/agents';
import { getDiff, addToGitignore, commit, runHookCommand, gitRead } from '@funny/core/git';
import { badRequest, internal } from '@funny/shared/errors';
import { Hono } from 'hono';
import { err } from 'neverthrow';

import { log } from '../../lib/logger.js';
import { requestSpan } from '../../middleware/tracing.js';
import { commitChanges as gitServiceCommit, resolveIdentity } from '../../services/git-service.js';
import { getPipelineForProject } from '../../services/pipeline-manager.js';
import {
  buildCommitMessagePrompt,
  COMMIT_MESSAGE_SYSTEM_PROMPT,
} from '../../services/pipeline-prompts.js';
import { listHooks } from '../../services/project-hooks-service.js';
import * as tm from '../../services/thread-manager.js';
import type { HonoEnv } from '../../types/hono-env.js';
import { resultToResponse } from '../../utils/result-response.js';
import { requireThread, requireThreadCwd, requireProject } from '../../utils/route-helpers.js';
import { validate, commitSchema } from '../../validation/schemas.js';
import { _gitStatusCache, invalidateGitStatusCache, requireProjectCwd } from './helpers.js';

export const commitRoutes = new Hono<HonoEnv>();

// POST /api/git/project/:projectId/commit
commitRoutes.post('/project/:projectId/commit', async (c) => {
  const projectId = c.req.param('projectId');
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireProjectCwd(projectId, userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const cwd = cwdResult.value;
  const raw = await c.req.json().catch(() => ({}));
  const parsed = validate(commitSchema, raw);
  if (parsed.isErr()) return resultToResponse(c, parsed);
  const identity = await resolveIdentity(userId);
  const result = await commit(
    cwd,
    parsed.value.message,
    identity,
    parsed.value.amend,
    parsed.value.noVerify,
  );
  if (result.isErr()) return resultToResponse(c, result);
  _gitStatusCache.delete(projectId);
  // Best-effort SHA capture for orchestrator / automation consumers.
  const sha = await gitRead(['rev-parse', 'HEAD'], { cwd, reject: false })
    .then((r) => (r.exitCode === 0 ? r.stdout.trim() : undefined))
    .catch(() => undefined);
  return c.json({ ok: true, output: result.value, sha });
});

// POST /api/git/project/:projectId/run-hook-command
// Runs a single pre-commit hook command by index for per-hook progress tracking
commitRoutes.post('/project/:projectId/run-hook-command', async (c) => {
  const projectId = c.req.param('projectId');
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireProjectCwd(projectId, userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const cwd = cwdResult.value;
  const raw = await c.req.json().catch(() => ({}));
  const hookIndex = raw?.hookIndex;
  if (typeof hookIndex !== 'number') {
    return resultToResponse(c, err(badRequest('hookIndex is required')));
  }
  const hooks = listHooks(cwd, 'pre-commit').filter((h) => h.enabled);
  if (hookIndex < 0 || hookIndex >= hooks.length) {
    return resultToResponse(c, err(badRequest(`Invalid hookIndex: ${hookIndex}`)));
  }
  const hookResult = await runHookCommand(cwd, hooks[hookIndex].command);
  if (hookResult.isErr()) return resultToResponse(c, hookResult);
  return c.json(hookResult.value);
});

// POST /api/git/project/:projectId/generate-commit-message
commitRoutes.post('/project/:projectId/generate-commit-message', async (c) => {
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const projectId = c.req.param('projectId');
  const cwdResult = await requireProjectCwd(projectId, userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const cwd = cwdResult.value;

  const body = await c.req.json().catch(() => ({}));
  const includeUnstaged = body?.includeUnstaged === true;

  const diffResult = await getDiff(cwd);
  if (diffResult.isErr()) return resultToResponse(c, diffResult);
  const diffs = diffResult.value;
  const relevantDiffs = includeUnstaged ? diffs : diffs.filter((d) => d.staged);

  if (relevantDiffs.length === 0) {
    return resultToResponse(c, err(badRequest('No files to generate a commit message for')));
  }

  let diffSummary = relevantDiffs
    .map((d) => `--- ${d.status}: ${d.path} ---\n${d.diff || '(no diff)'}`)
    .join('\n\n');

  const MAX_DIFF_LEN = 20_000;
  if (diffSummary.length > MAX_DIFF_LEN) {
    diffSummary = diffSummary.slice(0, MAX_DIFF_LEN) + '\n\n... (diff truncated for length)';
  }

  const pipelineCfg = await getPipelineForProject(projectId);
  const prompt = buildCommitMessagePrompt(diffSummary, pipelineCfg?.commitMessagePrompt);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);

  const output = await (async (): Promise<{ text: string } | { error: string }> => {
    try {
      let resultText = '';

      const gen = query({
        prompt,
        options: {
          cwd,
          maxTurns: 1,
          permissionMode: 'plan',
          abortController: controller,
          pathToClaudeCodeExecutable: resolveSDKCliPath(),
          systemPrompt: COMMIT_MESSAGE_SYSTEM_PROMPT,
          tools: [],
        },
      });

      for await (const msg of gen) {
        if (msg.type === 'assistant') {
          const content = (msg as any).message?.content;
          if (!content) continue;
          const text = content
            .filter((b: any) => b.type === 'text' && b.text)
            .map((b: any) => b.text)
            .join('\n');
          if (text) resultText = text;
        }
        if (msg.type === 'result') {
          const r = (msg as any).result || resultText;
          return r ? { text: r } : { error: 'No output received' };
        }
      }

      return resultText ? { text: resultText } : { error: 'No output received' };
    } catch (e: any) {
      log.error('SDK query error generating commit message', {
        namespace: 'git',
        error: e.message,
      });
      return { error: e.message || 'Unknown error' };
    } finally {
      clearTimeout(timeout);
    }
  })();

  if ('error' in output) {
    return resultToResponse(c, err(internal(output.error)));
  }

  const trimmed = output.text.trim();
  const errorPatterns = [
    /invalid api key/i,
    /authentication.*error/i,
    /fix external api key/i,
    /unauthorized/i,
    /api key.*invalid/i,
  ];
  if (errorPatterns.some((p) => p.test(trimmed))) {
    log.error('SDK auth error generating commit message', {
      namespace: 'git',
      output: trimmed.slice(0, 200),
    });
    return resultToResponse(c, err(internal(trimmed.split('\n')[0])));
  }

  const titleMatch = trimmed.match(/^TITLE:\s*(.+)/m);
  const bodyMatch = trimmed.match(/^BODY:\s*([\s\S]+)/m);

  if (!titleMatch) {
    log.error('Unexpected output from commit message generation', {
      namespace: 'git',
      output: trimmed.slice(0, 500),
    });
    return resultToResponse(c, err(internal('Failed to generate commit message')));
  }

  const title = titleMatch[1].trim();
  const commitBody = bodyMatch?.[1]?.trim() || '';

  return c.json({ title, body: commitBody });
});

// POST /api/git/project/:projectId/gitignore
commitRoutes.post('/project/:projectId/gitignore', async (c) => {
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireProjectCwd(c.req.param('projectId'), userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const cwd = cwdResult.value;
  const raw = await c.req.json().catch(() => ({}));
  const patterns: string[] = Array.isArray(raw?.patterns)
    ? raw.patterns.filter((p: unknown) => typeof p === 'string' && p)
    : typeof raw?.pattern === 'string' && raw.pattern
      ? [raw.pattern]
      : [];
  if (patterns.length === 0) {
    return c.json({ error: 'pattern or patterns is required' }, 400);
  }
  for (const p of patterns) {
    const result = addToGitignore(cwd, p);
    if (result.isErr()) return resultToResponse(c, result);
  }
  return c.json({ ok: true });
});

// POST /api/git/:threadId/commit
commitRoutes.post('/:threadId/commit', async (c) => {
  const threadId = c.req.param('threadId');
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireThreadCwd(threadId, userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const cwd = cwdResult.value;

  const raw = await c.req.json().catch(() => ({}));
  const parsed = validate(commitSchema, raw);
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
});

// POST /api/git/:threadId/run-hook-command
// Runs a single pre-commit hook command by index for per-hook progress tracking
commitRoutes.post('/:threadId/run-hook-command', async (c) => {
  const threadId = c.req.param('threadId');
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireThreadCwd(threadId, userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const cwd = cwdResult.value;
  const raw = await c.req.json().catch(() => ({}));
  const hookIndex = raw?.hookIndex;
  if (typeof hookIndex !== 'number') {
    return resultToResponse(c, err(badRequest('hookIndex is required')));
  }
  // Look up the project path for hook config (worktree cwd may differ from project root)
  const thread = await tm.getThread(threadId);
  const projectId = thread?.projectId;
  let hookCwd = cwd;
  if (projectId) {
    const project = await requireProject(projectId, userId, orgId);
    if (project.isOk()) hookCwd = project.value.path;
  }
  const hooks = listHooks(hookCwd, 'pre-commit').filter((h) => h.enabled);
  if (hookIndex < 0 || hookIndex >= hooks.length) {
    return resultToResponse(c, err(badRequest(`Invalid hookIndex: ${hookIndex}`)));
  }
  // Run the hook command in the thread's working directory (not the project root)
  const hookResult = await runHookCommand(cwd, hooks[hookIndex].command);
  if (hookResult.isErr()) return resultToResponse(c, hookResult);
  return c.json(hookResult.value);
});

// POST /api/git/:threadId/generate-commit-message
commitRoutes.post('/:threadId/generate-commit-message', async (c) => {
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const threadId = c.req.param('threadId');
  const threadResult = await requireThread(threadId, userId, orgId);
  if (threadResult.isErr()) return resultToResponse(c, threadResult);
  const thread = threadResult.value;

  const cwdResult = await requireThreadCwd(threadId, userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const cwd = cwdResult.value;

  const body = await c.req.json().catch(() => ({}));
  const includeUnstaged = body?.includeUnstaged === true;

  const diffResult = await getDiff(cwd);
  if (diffResult.isErr()) return resultToResponse(c, diffResult);
  const diffs = diffResult.value;
  const relevantDiffs = includeUnstaged ? diffs : diffs.filter((d) => d.staged);

  if (relevantDiffs.length === 0) {
    return resultToResponse(c, err(badRequest('No files to generate a commit message for')));
  }

  let diffSummary = relevantDiffs
    .map((d) => `--- ${d.status}: ${d.path} ---\n${d.diff || '(no diff)'}`)
    .join('\n\n');

  const MAX_DIFF_LEN = 20_000;
  if (diffSummary.length > MAX_DIFF_LEN) {
    diffSummary = diffSummary.slice(0, MAX_DIFF_LEN) + '\n\n... (diff truncated for length)';
  }

  const pipelineCfg = await getPipelineForProject(thread.projectId);
  const prompt = buildCommitMessagePrompt(diffSummary, pipelineCfg?.commitMessagePrompt);

  const span = requestSpan(c, 'ai.generate_commit_message', {
    diffLength: diffSummary.length,
    fileCount: relevantDiffs.length,
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);

  const output = await (async (): Promise<{ text: string } | { error: string }> => {
    try {
      let resultText = '';

      const gen = query({
        prompt,
        options: {
          cwd,
          maxTurns: 1,
          permissionMode: 'plan',
          abortController: controller,
          pathToClaudeCodeExecutable: resolveSDKCliPath(),
          systemPrompt: COMMIT_MESSAGE_SYSTEM_PROMPT,
          tools: [],
        },
      });

      for await (const msg of gen) {
        if (msg.type === 'assistant') {
          const content = (msg as any).message?.content;
          if (!content) continue;
          const text = content
            .filter((b: any) => b.type === 'text' && b.text)
            .map((b: any) => b.text)
            .join('\n');
          if (text) resultText = text;
        }
        if (msg.type === 'result') {
          const r = (msg as any).result || resultText;
          return r ? { text: r } : { error: 'No output received' };
        }
      }

      return resultText ? { text: resultText } : { error: 'No output received' };
    } catch (e: any) {
      log.error('SDK query error generating commit message', {
        namespace: 'git',
        error: e.message,
      });
      return { error: e.message || 'Unknown error' };
    } finally {
      clearTimeout(timeout);
    }
  })();

  if ('error' in output) {
    span.end('error', output.error);
    return resultToResponse(c, err(internal(output.error)));
  }

  span.end('ok');

  const trimmed = output.text.trim();
  const errorPatterns = [
    /invalid api key/i,
    /authentication.*error/i,
    /fix external api key/i,
    /unauthorized/i,
    /api key.*invalid/i,
  ];
  if (errorPatterns.some((p) => p.test(trimmed))) {
    log.error('SDK auth error generating commit message', {
      namespace: 'git',
      output: trimmed.slice(0, 200),
    });
    return resultToResponse(c, err(internal(trimmed.split('\n')[0])));
  }

  const titleMatch = trimmed.match(/^TITLE:\s*(.+)/m);
  const bodyMatch = trimmed.match(/^BODY:\s*([\s\S]+)/m);

  if (!titleMatch) {
    log.error('Unexpected output from commit message generation', {
      namespace: 'git',
      output: trimmed.slice(0, 500),
    });
    return resultToResponse(c, err(internal('Failed to generate commit message')));
  }

  const title = titleMatch[1].trim();
  const commitBody = bodyMatch?.[1]?.trim() || '';

  return c.json({ title, body: commitBody });
});

// POST /api/git/:threadId/gitignore
commitRoutes.post('/:threadId/gitignore', async (c) => {
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireThreadCwd(c.req.param('threadId'), userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const cwd = cwdResult.value;

  const raw = await c.req.json().catch(() => ({}));
  const patterns: string[] = Array.isArray(raw?.patterns)
    ? raw.patterns.filter((p: unknown) => typeof p === 'string' && p)
    : typeof raw?.pattern === 'string' && raw.pattern
      ? [raw.pattern]
      : [];
  if (patterns.length === 0) {
    return c.json({ error: 'pattern or patterns is required' }, 400);
  }
  for (const p of patterns) {
    const result = addToGitignore(cwd, p);
    if (result.isErr()) return resultToResponse(c, result);
  }
  return c.json({ ok: true });
});
