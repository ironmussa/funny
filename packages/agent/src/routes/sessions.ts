/**
 * Sessions HTTP routes.
 *
 * GET    /             — List all sessions
 * GET    /:id          — Get session detail with events
 * POST   /start        — Start a new session from an issue
 * POST   /:id/escalate — Manually escalate a session
 * POST   /:id/cancel   — Cancel a session
 * DELETE /:id          — Remove a session record
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import type { SessionStore } from '../core/session-store.js';
import type { OrchestratorAgent } from '../core/orchestrator-agent.js';
import type { Tracker } from '../trackers/tracker.js';
import type { EventBus } from '../infrastructure/event-bus.js';
import type { PipelineServiceConfig } from '../config/schema.js';
import { Session } from '../core/session.js';
import { nanoid } from 'nanoid';
import type { IssueRef } from '../core/session.js';
import { logger } from '../infrastructure/logger.js';

// ── Validation schemas ──────────────────────────────────────────

const StartSessionSchema = z.object({
  issueNumber: z.number().int().min(1).optional(),
  prompt: z.string().min(1).optional(),
  projectPath: z.string().min(1),
  model: z.string().optional(),
  provider: z.string().optional(),
  baseBranch: z.string().optional(),
  /** Skip planning and go straight to implementation */
  skipPlan: z.boolean().optional(),
  /** Inline issue details — used when no tracker is configured */
  title: z.string().optional(),
  body: z.string().optional(),
  labels: z.array(z.string()).optional(),
});

// ── Route factory ───────────────────────────────────────────────

export function createSessionRoutes(
  sessionStore: SessionStore,
  orchestratorAgent: OrchestratorAgent,
  tracker: Tracker | null,
  eventBus: EventBus,
  config: PipelineServiceConfig,
): Hono {
  const app = new Hono();

  // ── GET / — List sessions ───────────────────────────────────────

  app.get('/', (c) => {
    const status = c.req.query('status');
    const sessions = status
      ? sessionStore.byStatus(status as any)
      : sessionStore.list();

    return c.json({
      sessions: sessions.map((s) => s.toJSON()),
      total: sessions.length,
      active: sessionStore.activeCount(),
    });
  });

  // ── GET /:id — Session detail ─────────────────────────────────

  app.get('/:id', (c) => {
    const session = sessionStore.get(c.req.param('id'));
    if (!session) {
      return c.json({ error: 'Session not found' }, 404);
    }
    return c.json(session.toJSON());
  });

  // ── POST /start — Start session from issue ────────────────────

  app.post('/start', zValidator('json', StartSessionSchema), async (c) => {
    const body = c.req.valid('json');

    // Must provide either issueNumber, prompt, or title
    const promptText = body.prompt || body.title;
    if (!body.issueNumber && !promptText) {
      return c.json({ error: 'Provide either issueNumber, prompt, or title' }, 400);
    }

    const isPromptOnly = !body.issueNumber;

    // Check if issue already has an active session (skip for prompt-only)
    if (!isPromptOnly) {
      const existing = sessionStore.byIssue(body.issueNumber!);
      if (existing && existing.isActive) {
        // Allow retrying if the previous session is stuck (no activity for 2+ min)
        const updatedAt = new Date(existing.updatedAt).getTime();
        const staleMs = 2 * 60 * 1000;
        if (Date.now() - updatedAt < staleMs) {
          return c.json({
            error: 'Issue already has an active session',
            sessionId: existing.id,
            status: existing.status,
          }, 409);
        }
        // Stale session — cancel it and allow retry
        await sessionStore.transition(existing.id, 'cancelled', { reason: 'Superseded by new session' });
        logger.info({ oldSessionId: existing.id, issueNumber: body.issueNumber }, 'Cancelled stale session for retry');
      }
    }

    // Check parallel limit
    if (sessionStore.activeCount() >= config.tracker.max_parallel) {
      return c.json({
        error: `Max parallel sessions reached (${config.tracker.max_parallel})`,
        active: sessionStore.activeCount(),
      }, 429);
    }

    // Build issue ref: from tracker, inline data, or prompt
    let issueRef: IssueRef;

    if (isPromptOnly) {
      // Prompt-only session — use title/body or prompt
      const title = body.title || promptText!.slice(0, 80).replace(/\n/g, ' ');
      const description = body.body || body.prompt || title;
      issueRef = {
        number: 0,
        title,
        url: '',
        repo: config.tracker.repo ?? '',
        body: description,
        labels: body.labels ?? [],
      };
    } else if (tracker) {
      try {
        const issueDetail = await tracker.fetchIssueDetail(body.issueNumber!);
        issueRef = {
          number: issueDetail.number,
          title: issueDetail.title,
          url: issueDetail.url,
          repo: config.tracker.repo ?? '',
          body: issueDetail.body ?? undefined,
          labels: issueDetail.labels.map((l) => l.name),
        };
      } catch (err: any) {
        return c.json({ error: `Failed to fetch issue: ${err.message}` }, 502);
      }
    } else if (body.title) {
      // No tracker — use inline issue data
      issueRef = {
        number: body.issueNumber!,
        title: body.title,
        url: '',
        repo: config.tracker.repo ?? '',
        body: body.body ?? undefined,
        labels: body.labels ?? [],
      };
    } else {
      return c.json({
        error: 'No tracker configured. Provide inline issue details (title, body) or a prompt.',
      }, 503);
    }

    const session = new Session(issueRef, body.projectPath, {
      model: body.model ?? config.orchestrator.model,
      provider: body.provider ?? config.orchestrator.provider,
    });

    sessionStore.add(session);

    // Build branch name and title based on mode
    const branchPrefix = isPromptOnly ? 'prompt' : `issue/${issueRef.number}`;
    const displayTitle = isPromptOnly ? issueRef.title : `#${issueRef.number}: ${issueRef.title}`;

    // Emit accepted event so the ingest mapper creates a thread in the Funny UI.
    await eventBus.publish({
      event_type: 'session.accepted' as any,
      request_id: session.id,
      timestamp: new Date().toISOString(),
      data: {
        title: displayTitle,
        prompt: issueRef.body ?? issueRef.title,
        branch: `${branchPrefix}/${slugify(issueRef.title)}`,
        worktree_path: body.projectPath,
        model: session.model,
        created_by: 'agent-orchestrator',
      },
    });

    // Run inline: plan → implement → PR
    await sessionStore.transition(session.id, 'planning');

    const fullContext = isPromptOnly
      ? `Task: ${issueRef.title}\n\n${issueRef.body ?? ''}`
      : `#${issueRef.number}: ${issueRef.title}\n\n${issueRef.body ?? ''}`;

    const issueDetailForPlan: import('../trackers/tracker.js').IssueDetail = {
      number: issueRef.number,
      title: issueRef.title,
      state: 'open',
      body: issueRef.body ?? null,
      url: issueRef.url,
      labels: (issueRef.labels ?? []).map((l) => ({ name: l, color: '' })),
      assignee: null,
      commentsCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      comments: [],
      fullContext,
    };

    runIssuePipeline(
      session, issueDetailForPlan, body.projectPath,
      body.baseBranch ?? config.branch.main,
      sessionStore, orchestratorAgent, eventBus, config,
    ).catch(async (err) => {
      const errorMsg = err.message ?? String(err);
      logger.error({ sessionId: session.id, err: errorMsg }, 'Issue pipeline failed');
      await emitError(eventBus, session.id, `Pipeline failed: ${errorMsg}`, {
        sessionStore, fatal: true,
      });
    });

    // Comment on the issue to show it's being worked on (only for real issues)
    if (tracker && !isPromptOnly) {
      tracker.addComment(
        body.issueNumber!,
        `🤖 **funny agent** is now working on this issue.\n\nSession: \`${session.id}\``,
      ).catch((err) => {
        logger.warn({ err: err.message }, 'Failed to comment on issue');
      });
    }

    return c.json({
      sessionId: session.id,
      status: session.status,
      issueNumber: issueRef.number,
    }, 202);
  });

  // ── POST /:id/escalate — Manual escalation ────────────────────

  app.post('/:id/escalate', async (c) => {
    const id = c.req.param('id');
    const body = await c.req.json<{ reason?: string }>().catch(() => ({} as { reason?: string }));

    const ok = await sessionStore.transition(id, 'escalated', {
      reason: body.reason ?? 'Manual escalation',
    });

    if (!ok) {
      const session = sessionStore.get(id);
      if (!session) return c.json({ error: 'Session not found' }, 404);
      return c.json({ error: `Cannot escalate from status: ${session.status}` }, 409);
    }

    return c.json({ status: 'escalated', sessionId: id });
  });

  // ── POST /:id/cancel — Cancel a session ───────────────────────

  app.post('/:id/cancel', async (c) => {
    const id = c.req.param('id');

    const ok = await sessionStore.transition(id, 'cancelled', {
      reason: 'Cancelled by user',
    });

    if (!ok) {
      const session = sessionStore.get(id);
      if (!session) return c.json({ error: 'Session not found' }, 404);
      return c.json({ error: `Cannot cancel from status: ${session.status}` }, 409);
    }

    return c.json({ status: 'cancelled', sessionId: id });
  });

  // ── DELETE /:id — Remove session record ───────────────────────

  app.delete('/:id', (c) => {
    const id = c.req.param('id');
    const removed = sessionStore.remove(id);
    if (!removed) {
      return c.json({ error: 'Session not found' }, 404);
    }
    return c.json({ status: 'removed', sessionId: id });
  });

  return app;
}

// ── Error reporting helper ───────────────────────────────────────

/**
 * Publish an error message to the UI (visible in the thread chat)
 * and optionally transition the session to 'failed'.
 */
async function emitError(
  eventBus: EventBus,
  sessionId: string,
  message: string,
  opts?: { sessionStore?: SessionStore; fatal?: boolean },
) {
  await eventBus.publish({
    event_type: 'session.message' as any,
    request_id: sessionId,
    timestamp: new Date().toISOString(),
    data: { role: 'assistant', content: `Error: ${message}` },
  });

  if (opts?.fatal && opts.sessionStore) {
    await opts.sessionStore.transition(sessionId, 'failed', { error: message });
    await eventBus.publish({
      event_type: 'session.failed' as any,
      request_id: sessionId,
      timestamp: new Date().toISOString(),
      data: { error: message, error_message: `Error: ${message}` },
    });
  }
}

// ── Issue pipeline ──────────────────────────────────────────────

/**
 * Runs the full issue-to-PR pipeline.
 * Steps: plan → create worktree → implement → push → create PR
 */
async function runIssuePipeline(
  session: Session,
  issue: import('../trackers/tracker.js').IssueDetail,
  projectPath: string,
  baseBranch: string,
  sessionStore: SessionStore,
  orchestratorAgent: OrchestratorAgent,
  eventBus: EventBus,
  config: PipelineServiceConfig,
) {
  // Emit started so the UI transitions the thread from pending → running
  await eventBus.publish({
    event_type: 'session.started' as any,
    request_id: session.id,
    timestamp: new Date().toISOString(),
    data: {},
  });

  // Step 1: Plan
  logger.info({ sessionId: session.id }, 'Pipeline: planning');
  const plan = await orchestratorAgent.planIssue(issue, projectPath, {
    onEvent: async (event) => {
      switch (event.type) {
        case 'text':
          await eventBus.publish({
            event_type: 'session.plan_ready' as any,
            request_id: session.id,
            timestamp: new Date().toISOString(),
            data: { role: 'assistant', content: event.content },
          });
          break;
        case 'tool_call':
          await eventBus.publish({
            event_type: 'session.tool_call',
            request_id: session.id,
            timestamp: new Date().toISOString(),
            data: {
              tool_name: event.name,
              tool_input: event.args,
              tool_call_id: event.id,
            },
          });
          break;
        case 'tool_result':
          await eventBus.publish({
            event_type: 'session.tool_result',
            request_id: session.id,
            timestamp: new Date().toISOString(),
            data: {
              tool_call_id: event.id,
              output: event.result,
            },
          });
          break;
        case 'error':
          await emitError(eventBus, session.id, event.message);
          break;
      }
    },
  });
  sessionStore.update(session.id, (s) => s.setPlan(plan));
  await eventBus.publish({
    event_type: 'session.plan_ready',
    request_id: session.id,
    timestamp: new Date().toISOString(),
    data: { sessionId: session.id, plan },
  });

  logger.info(
    { sessionId: session.id, summary: plan.summary, complexity: plan.estimated_complexity },
    'Pipeline: plan ready',
  );

  // Step 2: Create worktree + branch
  const isPromptOnly = issue.number === 0;
  const branchPrefix = isPromptOnly ? 'prompt' : `issue/${issue.number}`;
  const branchName = `${branchPrefix}/${slugify(issue.title)}-${nanoid(5)}`;
  const { createWorktree } = await import('@funny/core/git');

  const wtResult = await createWorktree(projectPath, branchName, baseBranch);
  if (wtResult.isErr()) {
    logger.error({ err: wtResult.error }, 'Failed to create worktree');
    await emitError(eventBus, session.id, `Worktree creation failed: ${wtResult.error}`, {
      sessionStore, fatal: true,
    });
    return;
  }

  const worktreePath = wtResult.value;
  sessionStore.update(session.id, (s) => s.setBranch(branchName, worktreePath));
  await sessionStore.transition(session.id, 'implementing');

  logger.info(
    { sessionId: session.id, branch: branchName, worktreePath },
    'Pipeline: implementing',
  );

  // Step 3: Implement
  const implResult = await orchestratorAgent.implementIssue(
    issue, plan, worktreePath, branchName,
    {
      onEvent: async (event) => {
        switch (event.type) {
          case 'text':
            await eventBus.publish({
              event_type: 'session.message' as any,
              request_id: session.id,
              timestamp: new Date().toISOString(),
              data: { role: 'assistant', content: event.content },
            });
            break;
          case 'tool_call':
            await eventBus.publish({
              event_type: 'session.tool_call',
              request_id: session.id,
              timestamp: new Date().toISOString(),
              data: {
                tool_name: event.name,
                tool_input: event.args,
                tool_call_id: event.id,
              },
            });
            break;
          case 'tool_result':
            await eventBus.publish({
              event_type: 'session.tool_result',
              request_id: session.id,
              timestamp: new Date().toISOString(),
              data: {
                tool_call_id: event.id,
                output: event.result,
              },
            });
            break;
          case 'error':
            await emitError(eventBus, session.id, event.message);
            break;
        }
      },
    },
  );

  // Check if implementation had errors
  if (implResult.status === 'error') {
    const errorDetail = implResult.findings_count > 0
      ? `Implementation failed with ${implResult.findings_count} finding(s)`
      : 'Implementation failed';
    logger.error({ sessionId: session.id, status: implResult.status }, errorDetail);
    await emitError(eventBus, session.id, errorDetail, { sessionStore, fatal: true });
    return;
  }

  logger.info(
    { sessionId: session.id, status: implResult.status, findings: implResult.findings_count },
    'Pipeline: implementation complete',
  );

  // Step 4: Push + create PR
  const { push, createPR } = await import('@funny/core/git');
  const identity = process.env.GH_TOKEN ? { githubToken: process.env.GH_TOKEN } : undefined;

  const pushResult = await push(worktreePath, identity);
  if (pushResult.isErr()) {
    logger.error({ err: pushResult.error }, 'Failed to push branch');
    await emitError(eventBus, session.id, `Push failed: ${pushResult.error}`, {
      sessionStore, fatal: true,
    });
    return;
  }

  await sessionStore.transition(session.id, 'pr_created');

  const prTitle = isPromptOnly
    ? `feat: ${issue.title}`
    : `fix: ${issue.title} (Closes #${issue.number})`;
  const prBody = `## Summary\n\n${plan.summary}\n\n## Approach\n\n${plan.approach}\n\n---\n\nAutomated by funny agent session \`${session.id}\``;

  const prResult = await createPR(worktreePath, prTitle, prBody, baseBranch, identity);

  if (prResult.isOk()) {
    const prUrl = prResult.value;
    // Extract PR number from URL (e.g. https://github.com/org/repo/pull/42)
    const prNumber = parseInt(prUrl.split('/').pop() ?? '0', 10);
    sessionStore.update(session.id, (s) => s.setPR(prNumber, prUrl));
    logger.info(
      { sessionId: session.id, prNumber, prUrl },
      'Pipeline: PR created',
    );
  } else {
    logger.warn({ err: prResult.error }, 'PR creation failed — session still tracks the pushed branch');
    await emitError(eventBus, session.id, `PR creation failed: ${prResult.error}. Branch was pushed but PR could not be created.`);
  }

  // Transition to waiting for CI
  await sessionStore.transition(session.id, 'ci_running');

  // Emit completed so the UI transitions the thread to completed/review
  const issueLabel = isPromptOnly ? issue.title : `#${issue.number}: ${issue.title}`;
  const completionData: Record<string, string> = {
    result: prResult.isOk()
      ? `PR created for ${issueLabel}`
      : `Branch pushed for ${issueLabel} (PR creation failed)`,
  };
  if (prResult.isErr()) {
    completionData.error_message = `Error: PR creation failed: ${prResult.error}. Branch was pushed but PR could not be created.`;
  }
  await eventBus.publish({
    event_type: 'session.completed' as any,
    request_id: session.id,
    timestamp: new Date().toISOString(),
    data: completionData,
  });

  logger.info({ sessionId: session.id }, 'Pipeline: complete, waiting for CI/review');
}

/** Convert issue title to a git-branch-friendly slug */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}
