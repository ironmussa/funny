/**
 * @domain subdomain: Memory System (Paisley Park)
 * @domain type: event-handler
 * @domain layer: application
 * @domain consumes: agent:completed
 *
 * Triggers Paisley Park garbage collection after N thread completions.
 */

import { runGC, trackThreadCompletion, shouldRunGC, markGCComplete } from '@funny/memory';

import { log } from '../../lib/logger.js';
import type { EventHandler, HandlerServiceContext } from './types.js';

const GC_INTERVAL = Number(process.env.MEMORY_GC_INTERVAL) || 10;

export const memoryGCHandler: EventHandler<'agent:completed'> = {
  name: 'memory-gc-trigger',
  event: 'agent:completed',

  async action(payload, ctx) {
    const memoryEnabled =
      process.env.MEMORY_ENABLED === 'true' || process.env.MEMORY_ENABLED === '1';
    if (!memoryEnabled) return;

    trackThreadCompletion();

    if (!shouldRunGC(GC_INTERVAL)) return;

    const project = await ctx.getProject(payload.projectId);
    if (!project) return;

    log.info('Triggering memory GC', {
      namespace: 'memory:gc',
      projectId: payload.projectId,
    });

    // Run GC in the background — don't block the completion flow
    runGC(payload.projectId, (project as any).name ?? 'unknown')
      .then((result) => {
        if (result.isOk()) {
          markGCComplete();
          log.info('Memory GC completed', {
            namespace: 'memory:gc',
            projectId: payload.projectId,
            result: result.value,
          });
        }
      })
      .catch((err) => {
        log.error('Memory GC failed', {
          namespace: 'memory:gc',
          projectId: payload.projectId,
          error: String(err),
        });
      });
  },
};
