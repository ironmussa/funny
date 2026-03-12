/**
 * @domain subdomain: Shared Kernel
 * @domain type: context-map
 * @domain layer: application
 * @domain depends: ThreadEventBus
 *
 * Collects all reactive handlers and wires them to the ThreadEventBus at server startup.
 */

import { log } from '../../lib/logger.js';
import { threadEventBus, type ThreadEventMap } from '../thread-event-bus.js';
import { agentCompletedGitStatusHandler } from './agent-completed-git-status-handler.js';
import { agentCompletedQueueHandler } from './agent-completed-queue-handler.js';
// ── Import handlers ─────────────────────────────────────────────
import { commentHandler } from './comment-handler.js';
import {
  gitCommitPersistenceHandler,
  gitPushPersistenceHandler,
  gitMergePersistenceHandler,
  gitStagePersistenceHandler,
  gitUnstagePersistenceHandler,
  gitRevertPersistenceHandler,
  gitPullPersistenceHandler,
  gitStashPersistenceHandler,
  gitStashPopPersistenceHandler,
  gitResetSoftPersistenceHandler,
} from './git-event-persistence-handler.js';
import { gitStatusHandler } from './git-status-handler.js';
import { gitWatcherStartHandler, gitWatcherStopHandler } from './git-watcher-lifecycle-handler.js';
import { memoryGCHandler } from './memory-gc-handler.js';
import { pipelineTriggerHandler } from './pipeline-trigger-handler.js';
import { stageTransitionOnAgentStartHandler } from './stage-transition-on-agent-start-handler.js';
import {
  gitCommitTelemetryHandler,
  gitPushTelemetryHandler,
  gitMergeTelemetryHandler,
  gitPullTelemetryHandler,
  gitStageTelemetryHandler,
  gitUnstageTelemetryHandler,
  gitRevertTelemetryHandler,
  gitStashTelemetryHandler,
  gitStashPopTelemetryHandler,
  gitResetSoftTelemetryHandler,
} from './telemetry-handler.js';
import { threadDeletedWsHandler } from './thread-deleted-ws-handler.js';
import { threadStageChangedWsHandler } from './thread-stage-changed-ws-handler.js';
import type { EventHandler, HandlerServiceContext } from './types.js';

// ── Handler list ────────────────────────────────────────────────

const allHandlers: EventHandler<any>[] = [
  commentHandler,
  gitStatusHandler,
  gitCommitPersistenceHandler,
  gitPushPersistenceHandler,
  gitMergePersistenceHandler,
  gitStagePersistenceHandler,
  gitUnstagePersistenceHandler,
  gitRevertPersistenceHandler,
  gitPullPersistenceHandler,
  gitStashPersistenceHandler,
  gitStashPopPersistenceHandler,
  gitResetSoftPersistenceHandler,
  agentCompletedGitStatusHandler,
  agentCompletedQueueHandler,
  stageTransitionOnAgentStartHandler,
  threadDeletedWsHandler,
  threadStageChangedWsHandler,
  gitWatcherStartHandler,
  gitWatcherStopHandler,
  // Pipeline
  pipelineTriggerHandler,
  // Memory
  memoryGCHandler,
  // Telemetry
  gitCommitTelemetryHandler,
  gitPushTelemetryHandler,
  gitMergeTelemetryHandler,
  gitPullTelemetryHandler,
  gitStageTelemetryHandler,
  gitUnstageTelemetryHandler,
  gitRevertTelemetryHandler,
  gitStashTelemetryHandler,
  gitStashPopTelemetryHandler,
  gitResetSoftTelemetryHandler,
];

// ── Registration ────────────────────────────────────────────────

/**
 * Wire all handlers to the event bus.
 * Call once at server startup.
 */
export function registerAllHandlers(ctx: HandlerServiceContext): void {
  for (const handler of allHandlers) {
    const wrappedListener = async (payload: any) => {
      try {
        if (handler.filter && !(await handler.filter(payload, ctx))) {
          return;
        }
        await handler.action(payload, ctx);
      } catch (err) {
        log.error(`Handler "${handler.name}" error`, {
          namespace: 'handler-registry',
          handler: handler.name,
          error: err,
        });
      }
    };

    threadEventBus.on(handler.event as keyof ThreadEventMap, wrappedListener as any);
    log.debug(`Registered handler "${handler.name}" on "${handler.event}"`, {
      namespace: 'handler-registry',
      handler: handler.name,
      event: handler.event,
    });
  }

  log.info(`${allHandlers.length} handler(s) registered`, {
    namespace: 'handler-registry',
    count: allHandlers.length,
  });
}
