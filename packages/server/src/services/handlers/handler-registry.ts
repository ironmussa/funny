/**
 * Handler Registry — collects all reactive handlers and wires them
 * to the ThreadEventBus at server startup.
 *
 * To add a new handler:
 *   1. Create a file in this directory exporting an EventHandler
 *   2. Import it here and add it to the allHandlers array
 */

import { log } from '../../lib/logger.js';
import { threadEventBus, type ThreadEventMap } from '../thread-event-bus.js';
import { agentCompletedGitStatusHandler } from './agent-completed-git-status-handler.js';
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
        if (handler.filter && !handler.filter(payload, ctx)) {
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
