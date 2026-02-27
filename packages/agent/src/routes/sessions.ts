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

import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { z } from 'zod';

import type { PipelineServiceConfig } from '../config/schema.js';
import type { SessionStore } from '../core/session-store.js';
import { Session } from '../core/session.js';
import type { IssueRef } from '../core/session.js';
import type { EventBus } from '../infrastructure/event-bus.js';
import { logger } from '../infrastructure/logger.js';
import type { Tracker } from '../trackers/tracker.js';
import type { IssuePipelineWorkflow } from '../workflows/issue-pipeline.workflow.js';

// ── Validation schemas ──────────────────────────────────────────

const StartSessionSchema = z.object({
  issueNumber: z.number().int().min(1).optional(),
  prompt: z.string().min(1).optional(),
  projectPath: z.string().min(1),
  model: z.string().optional(),
  provider: z.string().optional(),
  baseBranch: z.string().min(1),
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
  issuePipeline: IssuePipelineWorkflow,
  tracker: Tracker | null,
  eventBus: EventBus,
  config: PipelineServiceConfig,
): Hono {
  const app = new Hono();

  // ── GET / — List sessions ───────────────────────────────────────

  app.get('/', (c) => {
    const status = c.req.query('status');
    const sessions = status ? sessionStore.byStatus(status as any) : sessionStore.list();

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
          return c.json(
            {
              error: 'Issue already has an active session',
              sessionId: existing.id,
              status: existing.status,
            },
            409,
          );
        }
        // Stale session — cancel it and allow retry
        await sessionStore.transition(existing.id, 'cancelled', {
          reason: 'Superseded by new session',
        });
        logger.info(
          { oldSessionId: existing.id, issueNumber: body.issueNumber },
          'Cancelled stale session for retry',
        );
      }
    }

    // Check parallel limit
    if (sessionStore.activeCount() >= config.tracker.max_parallel) {
      return c.json(
        {
          error: `Max parallel sessions reached (${config.tracker.max_parallel})`,
          active: sessionStore.activeCount(),
        },
        429,
      );
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
      return c.json(
        {
          error: 'No tracker configured. Provide inline issue details (title, body) or a prompt.',
        },
        503,
      );
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

    // Run the pipeline: plan → implement → PR
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

    issuePipeline
      .run({
        session,
        issue: issueDetailForPlan,
        projectPath: body.projectPath,
        baseBranch: body.baseBranch,
      })
      .catch(async (err) => {
        const errorMsg = err.message ?? String(err);
        logger.error({ sessionId: session.id, err: errorMsg }, 'Issue pipeline failed');
        await eventBus.publish({
          event_type: 'session.message' as any,
          request_id: session.id,
          timestamp: new Date().toISOString(),
          data: { role: 'assistant', content: `Error: Pipeline failed: ${errorMsg}` },
        });
        await sessionStore.transition(session.id, 'failed', { error: errorMsg });
        await eventBus.publish({
          event_type: 'session.failed' as any,
          request_id: session.id,
          timestamp: new Date().toISOString(),
          data: { error: errorMsg, error_message: `Error: Pipeline failed: ${errorMsg}` },
        });
      });

    // Comment on the issue to show it's being worked on (only for real issues)
    if (tracker && !isPromptOnly) {
      tracker
        .addComment(
          body.issueNumber!,
          `🤖 **funny agent** is now working on this issue.\n\nSession: \`${session.id}\``,
        )
        .catch((err) => {
          logger.warn({ err: err.message }, 'Failed to comment on issue');
        });
    }

    return c.json(
      {
        sessionId: session.id,
        status: session.status,
        issueNumber: issueRef.number,
      },
      202,
    );
  });

  // ── POST /:id/escalate — Manual escalation ────────────────────

  app.post('/:id/escalate', async (c) => {
    const id = c.req.param('id');
    const body = await c.req.json<{ reason?: string }>().catch(() => ({}) as { reason?: string });

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

/** Convert issue title to a git-branch-friendly slug */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}
