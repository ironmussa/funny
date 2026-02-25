/**
 * @funny/agent — Agent Service HTTP app.
 *
 * Minimal wiring: sessions, reactions, orchestrator, webhooks.
 * Flow: Issue → Plan → Implement → PR → CI/Review reactions.
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger as honoLogger } from 'hono/logger';
import { loadConfig } from './config/loader.js';
import type { PipelineServiceConfig } from './config/schema.js';
import { createWebhookRoutes } from './routes/webhooks.js';
import { createSessionRoutes } from './routes/sessions.js';
import { EventBus } from './infrastructure/event-bus.js';
import { ModelFactory } from '@funny/core/agents';
import { SessionStore } from './core/session-store.js';
import { OrchestratorAgent } from './core/orchestrator-agent.js';
import { ReactionEngine } from './core/reactions.js';
import { GitHubTracker } from './trackers/github-tracker.js';
import type { Tracker } from './trackers/tracker.js';
import { IngestWebhookAdapter } from './infrastructure/ingest-webhook-adapter.js';
import { logger } from './infrastructure/logger.js';

// ── Bootstrap ────────────────────────────────────────────────────

const projectPath = process.env.PROJECT_PATH ?? process.cwd();

// Load config (YAML + defaults)
const config: PipelineServiceConfig = await loadConfig(projectPath);

// ── Singletons ──────────────────────────────────────────────────

const eventBus = new EventBus(config.events.path ?? undefined);

// Create shared ModelFactory
const modelFactory = new ModelFactory({
  anthropic: {
    apiKey: process.env[config.llm_providers.anthropic.api_key_env],
    baseURL: config.llm_providers.anthropic.base_url || undefined,
  },
  'funny-api-acp': {
    apiKey: process.env[config.llm_providers.funny_api_acp.api_key_env],
    baseURL: config.llm_providers.funny_api_acp.base_url || undefined,
  },
  ollama: {
    baseURL: config.llm_providers.ollama.base_url || undefined,
  },
});

// ── Session & Orchestrator singletons ───────────────────────────

const sessionStore = new SessionStore(eventBus, config.sessions.persist_path ?? undefined);
const orchestratorAgent = new OrchestratorAgent(config, modelFactory);

// Initialize tracker (GitHub by default, gracefully handles missing `gh` CLI)
let tracker: Tracker | null = null;
try {
  if (config.tracker.type === 'github') {
    tracker = config.tracker.repo
      ? new GitHubTracker(config.tracker.repo, projectPath)
      : await GitHubTracker.fromCwd(projectPath);
    logger.info({ tracker: 'github', repo: config.tracker.repo }, 'Issue tracker initialized');
  }
} catch (err: any) {
  logger.warn({ err: err.message }, 'Issue tracker initialization failed — sessions will work without tracker');
}

// Initialize ReactionEngine
const reactionEngine = new ReactionEngine(eventBus, sessionStore, config, {
  respawnAgent: async (sessionId, prompt) => {
    const session = sessionStore.get(sessionId);
    if (!session || !session.worktreePath || !session.branch) return;

    // Re-run the implementing agent with the new prompt
    orchestratorAgent.implementIssue(
      {
        number: session.issue.number,
        title: session.issue.title,
        state: 'open',
        body: session.issue.body ?? null,
        url: session.issue.url,
        labels: session.issue.labels.map((l) => ({ name: l, color: '' })),
        assignee: null,
        commentsCount: 0,
        createdAt: '',
        updatedAt: '',
        comments: [],
        fullContext: `${session.issue.body ?? ''}\n\n---\n\n**Agent instructions:** ${prompt}`,
      },
      session.plan!,
      session.worktreePath,
      session.branch,
    ).catch((err) => {
      logger.error({ sessionId, err: err.message }, 'Respawned agent failed');
    });
  },
  notify: async (sessionId, message) => {
    logger.info({ sessionId, message }, 'Session notification');
    await eventBus.publish({
      event_type: 'reaction.triggered',
      request_id: sessionId,
      timestamp: new Date().toISOString(),
      data: { sessionId, message, type: 'notification' },
    });
  },
  autoMerge: async (sessionId) => {
    const session = sessionStore.get(sessionId);
    if (!session?.prNumber) return;
    const { execute } = await import('@funny/core/git');
    const ghEnv = process.env.GH_TOKEN ? { GH_TOKEN: process.env.GH_TOKEN } : undefined;
    await execute('gh', ['pr', 'merge', String(session.prNumber), '--squash', '--delete-branch'], {
      cwd: session.projectPath,
      env: ghEnv,
    });
    await sessionStore.transition(sessionId, 'merged', { autoMerged: true });
    logger.info({ sessionId, prNumber: session.prNumber }, 'PR auto-merged');
  },
});

reactionEngine.start();

// ── Ingest webhook adapter (forwards events to the Funny UI server) ──
const ingestAdapter = new IngestWebhookAdapter(eventBus);
ingestAdapter.start();

// ── Hono app ────────────────────────────────────────────────────

const app = new Hono();

app.use('*', cors());
app.use('*', honoLogger());

// Health check
app.get('/health', (c) => c.json({ status: 'ok', service: 'agent' }));

// Mount route groups
app.route('/webhooks', createWebhookRoutes(eventBus, config));
app.route('/sessions', createSessionRoutes(sessionStore, orchestratorAgent, tracker, eventBus, config));

// ── Exports ─────────────────────────────────────────────────────

export { app, eventBus, config, sessionStore, orchestratorAgent, reactionEngine, tracker, ingestAdapter };
export type { PipelineEvent, PipelineEventType } from './core/types.js';
export type { PipelineServiceConfig } from './config/schema.js';
