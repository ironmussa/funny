import type { PipelineEventType } from '../core/types.js';
import type { EventBus } from '../infrastructure/event-bus.js';

/**
 * Helper that encapsulates the repeated event publishing pattern.
 * Every workflow uses this instead of calling eventBus.publish() directly,
 * ensuring consistent event shape.
 */
export class WorkflowEventEmitter {
  constructor(private eventBus: EventBus) {}

  async emit(
    type: PipelineEventType,
    sessionId: string,
    data: Record<string, unknown> = {},
  ): Promise<void> {
    await this.eventBus.publish({
      event_type: type,
      request_id: sessionId,
      timestamp: new Date().toISOString(),
      data,
    });
  }
}
