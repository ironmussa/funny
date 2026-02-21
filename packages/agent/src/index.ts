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
import { createPipelineRoutes } from './routes/pipeline.js';
import { createDirectorRoutes } from './routes/director.js';
import { createWebhookRoutes } from './routes/webhooks.js';
import { createLogRoutes } from './routes/logs.js';
import { PipelineRunner } from './core/pipeline-runner.js';
import { EventBus } from './infrastructure/event-bus.js';
import { ManifestManager } from './core/manifest-manager.js';
import { Integrator } from './core/integrator.js';
import { Director } from './core/director.js';
import { BranchCleaner } from './core/branch-cleaner.js';
import { logger } from './infrastructure/logger.js';
import type { PipelineEvent } from './core/types.js';
import type { Tier, ManifestReadyEntry } from './core/manifest-types.js';

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
const runner = new PipelineRunner(eventBus, config, circuitBreakers, requestLogger);
const manifestManager = new ManifestManager(projectPath);
const integrator = new Integrator(eventBus, config, circuitBreakers);
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

// ── Event-driven wiring ─────────────────────────────────────────

// Manifest Writer: when pipeline completes, add branch to ready[]
eventBus.on('event', async (event: PipelineEvent) => {
  if (event.event_type !== 'pipeline.completed') return;

  const { branch, pipeline_branch, worktree_path, tier } = event.data as Record<string, any>;
  if (!branch) return;

  try {
    const entry: ManifestReadyEntry = {
      branch,
      pipeline_branch: pipeline_branch ?? `${config.branch.pipeline_prefix}${branch}`,
      worktree_path: worktree_path ?? '',
      request_id: event.request_id,
      tier: (tier as Tier) ?? 'medium',
      pipeline_result: (event.data.result as any) ?? {},
      corrections_applied: (event.data.corrections_applied as string[]) ?? [],
      ready_at: new Date().toISOString(),
      priority: (event.metadata?.priority as number) ?? config.director.default_priority,
      depends_on: (event.metadata?.depends_on as string[]) ?? [],
      base_main_sha: '',
      metadata: event.metadata,
    };
    await manifestManager.addToReady(entry);
  } catch (err: any) {
    logger.error({ err: err.message, branch }, 'Manifest Writer: failed to add to ready[]');
  }
});

// Idempotency release: when pipeline completes or fails, release the branch
eventBus.on('event', (event: PipelineEvent) => {
  if (
    event.event_type !== 'pipeline.completed' &&
    event.event_type !== 'pipeline.failed' &&
    event.event_type !== 'pipeline.stopped'
  ) return;

  const branch = (event.data as Record<string, any>).branch;
  if (branch) {
    idempotencyGuard.release(branch);
  }
});

// Director auto-trigger: when pipeline completes, run a director cycle
eventBus.on('event', async (event: PipelineEvent) => {
  if (event.event_type !== 'pipeline.completed') return;
  if (director.isRunning()) return;

  // Configurable delay to ensure manifest write completes first
  setTimeout(() => {
    director.runCycle('event').catch((err) => {
      logger.error({ err: err.message }, 'Director auto-cycle failed');
    });
  }, config.director.auto_trigger_delay_ms);
});

// Stale PR rebase: when Director detects base SHA mismatch, trigger rebase
eventBus.on('event', async (event: PipelineEvent) => {
  if (event.event_type !== 'director.pr.rebase_needed') return;

  const { branch, new_base } = event.data as Record<string, any>;
  if (!branch) return;

  const pendingEntry = await manifestManager.findPendingMerge(branch);
  if (!pendingEntry) return;

  try {
    const result = await integrator.rebase(pendingEntry, projectPath, new_base as string);
    if (result.success) {
      await manifestManager.updatePendingMergeBaseSha(branch, new_base as string);
    }
  } catch (err: any) {
    logger.error({ err: err.message, branch }, 'Rebase handler failed');
  }
});

// Branch cleanup: when pipeline completes, delete pipeline branch
eventBus.on('event', async (event: PipelineEvent) => {
  if (event.event_type !== 'pipeline.completed') return;

  const { pipeline_branch } = event.data as Record<string, any>;
  if (!pipeline_branch) return;

  // Small delay to let manifest write complete first
  setTimeout(() => {
    branchCleaner.cleanupAfterPipelineApproved(projectPath, pipeline_branch, event.request_id).catch((err) => {
      logger.error({ err: err.message, pipeline_branch }, 'Pipeline branch cleanup failed');
    });
  }, config.director.auto_trigger_delay_ms);
});

// Branch cleanup: when pipeline fails, conditionally delete pipeline branch
eventBus.on('event', async (event: PipelineEvent) => {
  if (event.event_type !== 'pipeline.failed') return;

  const { pipeline_branch } = event.data as Record<string, any>;
  if (!pipeline_branch) return;

  branchCleaner.handleFailedPipeline(projectPath, pipeline_branch, event.request_id).catch((err) => {
    logger.error({ err: err.message, pipeline_branch }, 'Failed pipeline branch cleanup failed');
  });
});

// Branch cleanup: when PR is merged (via GitHub webhook), delete branches + move to history
eventBus.on('event', async (event: PipelineEvent) => {
  if (event.event_type !== 'integration.pr.merged') return;

  const { branch, pipeline_branch, integration_branch } = event.data as Record<string, any>;
  if (!branch) return;

  try {
    await manifestManager.moveToMergeHistory(branch);
  } catch (err: any) {
    logger.error({ err: err.message, branch }, 'Failed to move branch to merge_history');
  }

  try {
    await branchCleaner.cleanupAfterMerge(
      projectPath,
      branch,
      pipeline_branch ?? `${config.branch.pipeline_prefix}${branch}`,
      integration_branch ?? `${config.branch.integration_prefix}${branch}`,
      event.request_id,
    );
  } catch (err: any) {
    logger.error({ err: err.message, branch }, 'Post-merge branch cleanup failed');
  }
});

// ── Hono app ────────────────────────────────────────────────────

const app = new Hono();

app.use('*', cors());
app.use('*', honoLogger());

// Health check
app.get('/health', (c) => c.json({ status: 'ok', service: 'pipeline' }));

// Mount route groups
app.route('/pipeline', createPipelineRoutes(runner, eventBus, idempotencyGuard));
app.route('/director', createDirectorRoutes(director, manifestManager));
app.route('/webhooks', createWebhookRoutes(eventBus, config));
app.route('/logs', createLogRoutes(requestLogger));

// ── Exports ─────────────────────────────────────────────────────

export { app, runner, eventBus, director, manifestManager, integrator, config, idempotencyGuard, dlq, branchCleaner, adapterManager, requestLogger };
export type { PipelineRequest, PipelineEvent, PipelineEventType, PipelineState, Tier, AgentName } from './core/types.js';
export type { Manifest, IntegratorResult, DirectorStatus } from './core/manifest-types.js';
export type { PipelineServiceConfig } from './config/schema.js';
export { isHatchetEnabled } from './hatchet/client.js';
export { startHatchetWorker } from './hatchet/worker.js';
