/**
 * @funny/agent — Pipeline Service HTTP app.
 *
 * Wires config, circuit breakers, idempotency guard, DLQ, adapters,
 * branch cleaner, request logger, and all core components together.
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger as honoLogger } from 'hono/logger';
import { loadConfig } from './config/loader.js';
import type { PipelineServiceConfig } from './config/schema.js';
import { createCircuitBreakers } from './infrastructure/circuit-breaker.js';
import type { CircuitBreakers } from './infrastructure/circuit-breaker.js';
import { IdempotencyGuard } from './infrastructure/idempotency.js';
import { DeadLetterQueue } from './infrastructure/dlq.js';
import { AdapterManager } from './infrastructure/adapter.js';
import { WebhookAdapter } from './infrastructure/webhook-adapter.js';
import { RequestLogger } from './infrastructure/request-logger.js';
import { createWebhookRoutes } from './routes/webhooks.js';
import { createLogRoutes } from './routes/logs.js';
import { createSessionRoutes } from './routes/sessions.js';
import { PipelineRunner } from './core/pipeline-runner.js';
import { EventBus } from './infrastructure/event-bus.js';
import { ManifestManager } from './core/manifest-manager.js';
import { Integrator } from './core/integrator.js';
import { Director } from './core/director.js';
import { BranchCleaner } from './core/branch-cleaner.js';
import { ModelFactory } from '@funny/core/agents';
import { SessionStore } from './core/session-store.js';
import { OrchestratorAgent } from './core/orchestrator-agent.js';
import { ReactionEngine } from './core/reactions.js';
import { GitHubTracker } from './trackers/github-tracker.js';
import type { Tracker } from './trackers/tracker.js';
import { logger } from './infrastructure/logger.js';
import { registerManifestWriter } from './listeners/manifest-writer.js';
import { registerIdempotencyReleaser } from './listeners/idempotency-releaser.js';
import { registerDirectorTrigger } from './listeners/director-trigger.js';
import { registerRebaseTrigger } from './listeners/rebase-trigger.js';
import { registerPipelineCleanup } from './listeners/pipeline-cleanup.js';
import { registerMergeCleanup } from './listeners/merge-cleanup.js';
import { RateLimiter } from './infrastructure/rate-limiter.js';
import { ServiceContainer } from './infrastructure/service-container.js';

// ── Bootstrap ────────────────────────────────────────────────────

const projectPath = process.env.PROJECT_PATH ?? process.cwd();

// Load config (YAML + defaults)
const config: PipelineServiceConfig = await loadConfig(projectPath);

// Create circuit breakers from config
const circuitBreakers: CircuitBreakers = createCircuitBreakers(
  config.resilience.circuit_breaker,
);

// Create idempotency guard and load persisted state
const pipelineDir = `${projectPath}/.pipeline`;
const idempotencyGuard = new IdempotencyGuard(pipelineDir);
await idempotencyGuard.loadFromDisk();

// Create DLQ
const dlq = new DeadLetterQueue(config.resilience.dlq, projectPath);

// Create request logger
const requestLogger = new RequestLogger(projectPath, config.logging.level as any);

// ── Singletons ──────────────────────────────────────────────────

const eventBus = new EventBus(config.events.path ?? undefined);

// Create shared ModelFactory (used by PipelineRunner and Integrator)
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

const runner = new PipelineRunner(eventBus, config, modelFactory, circuitBreakers, requestLogger);
const manifestManager = new ManifestManager(projectPath);
const integrator = new Integrator(eventBus, config, modelFactory, circuitBreakers);
const director = new Director(manifestManager, integrator, eventBus, projectPath, requestLogger);
const branchCleaner = new BranchCleaner(eventBus, config.cleanup);

// Create adapter manager and register webhook adapters from config
const adapterManager = new AdapterManager(eventBus, dlq, config.adapters.retry_interval_ms);
for (const webhookConfig of config.adapters.webhooks) {
  adapterManager.register(new WebhookAdapter(webhookConfig));
}

// Auto-register the built-in ingest webhook so pipeline events reach the UI.
// Configure via INGEST_WEBHOOK_URL in .env, or defaults to http://localhost:3001/api/ingest/webhook
const ingestUrl = process.env.INGEST_WEBHOOK_URL ?? `http://localhost:${process.env.SERVER_PORT ?? '3001'}/api/ingest/webhook`;
const ingestSecret = process.env.INGEST_WEBHOOK_SECRET;
adapterManager.register(new WebhookAdapter({
  url: ingestUrl,
  secret: ingestSecret,
}));
logger.info({ url: ingestUrl }, 'Registered built-in ingest webhook adapter');

adapterManager.start();

// Start Director scheduler (0 = disabled)
director.startSchedule(config.director.schedule_interval_ms);

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
      event_type: 'reaction.triggered' as any,
      request_id: sessionId,
      timestamp: new Date().toISOString(),
      data: { sessionId, message, type: 'notification' },
    });
  },
  autoMerge: async (sessionId) => {
    const session = sessionStore.get(sessionId);
    if (!session?.prNumber) return;
    const { execute } = await import('@funny/core/git');
    await execute('gh', ['pr', 'merge', String(session.prNumber), '--squash', '--delete-branch'], {
      cwd: session.projectPath,
    });
    await sessionStore.transition(sessionId, 'merged', { autoMerged: true });
    logger.info({ sessionId, prNumber: session.prNumber }, 'PR auto-merged');
  },
});

reactionEngine.start();

// ── Event-driven wiring ─────────────────────────────────────────

registerManifestWriter({ eventBus, manifestManager, config });
registerIdempotencyReleaser({ eventBus, idempotencyGuard });
registerDirectorTrigger({ eventBus, director, config });
registerRebaseTrigger({ eventBus, manifestManager, integrator, projectPath });
registerPipelineCleanup({ eventBus, branchCleaner, config, projectPath });
registerMergeCleanup({ eventBus, manifestManager, branchCleaner, config, projectPath });

// ── Rate limiters ──────────────────────────────────────────────

// Pipeline runs: 10 per minute (expensive LLM operations)
const pipelineRunLimiter = new RateLimiter({ max: 10, windowMs: 60_000 });
// Webhooks: 60 per minute (GitHub can burst events)
const webhookLimiter = new RateLimiter({ max: 60, windowMs: 60_000 });

// ── Hono app ────────────────────────────────────────────────────

const app = new Hono();

app.use('*', cors());
app.use('*', honoLogger());

// Health check
app.get('/health', (c) => c.json({ status: 'ok', service: 'pipeline' }));

// Rate-limit mutation endpoints
app.use('/pipeline/run', pipelineRunLimiter.middleware());
app.use('/director/run', pipelineRunLimiter.middleware());
app.use('/webhooks/*', webhookLimiter.middleware());

// Mount route groups
app.route('/webhooks', createWebhookRoutes(eventBus, config));
app.route('/logs', createLogRoutes(requestLogger));
app.route('/sessions', createSessionRoutes(sessionStore, orchestratorAgent, tracker, eventBus, config));

// ── Service container ──────────────────────────────────────────

const container = new ServiceContainer();
container.registerInstance('config', config);
container.registerInstance('eventBus', eventBus);
container.registerInstance('modelFactory', modelFactory);
container.registerInstance('runner', runner);
container.registerInstance('manifestManager', manifestManager);
container.registerInstance('integrator', integrator);
container.registerInstance('director', director, () => director.stopSchedule());
container.registerInstance('branchCleaner', branchCleaner);
container.registerInstance('idempotencyGuard', idempotencyGuard);
container.registerInstance('dlq', dlq);
container.registerInstance('adapterManager', adapterManager, () => adapterManager.stop());
container.registerInstance('requestLogger', requestLogger);
container.registerInstance('pipelineRunLimiter', pipelineRunLimiter, () => pipelineRunLimiter.dispose());
container.registerInstance('webhookLimiter', webhookLimiter, () => webhookLimiter.dispose());

// ── Exports ─────────────────────────────────────────────────────

export { app, container, runner, eventBus, director, manifestManager, integrator, config, idempotencyGuard, dlq, branchCleaner, adapterManager, requestLogger, sessionStore, orchestratorAgent, reactionEngine, tracker };
export type { PipelineRequest, PipelineEvent, PipelineEventType, PipelineState, Tier, AgentName } from './core/types.js';
export type { Manifest, IntegratorResult, DirectorStatus } from './core/manifest-types.js';
export type { PipelineServiceConfig } from './config/schema.js';
export { ServiceContainer } from './infrastructure/service-container.js';
export { isHatchetEnabled } from './hatchet/client.js';
export { startHatchetWorker } from './hatchet/worker.js';
