/**
 * EventBus — publish PipelineEvents with JSONL persistence.
 *
 * Uses eventemitter3 for typed, fast in-memory pub/sub.
 * Persists events to {EVENTS_PATH}/{request_id}.jsonl via Bun.write().
 */

import EventEmitter from 'eventemitter3';
import { join } from 'path';
import { mkdirSync, existsSync } from 'fs';
import type { PipelineEvent } from '../core/types.js';
import { logger } from './logger.js';

const DEFAULT_EVENTS_PATH = join(
  process.env.HOME ?? process.env.USERPROFILE ?? '.',
  '.funny',
  'pipeline-events',
);

interface EventBusEvents {
  event: (event: PipelineEvent) => void;
}

export class EventBus extends EventEmitter<EventBusEvents> {
  private persistPath: string;

  constructor(persistPath?: string) {
    super();
    this.persistPath = persistPath ?? process.env.EVENTS_PATH ?? DEFAULT_EVENTS_PATH;

    // Ensure persist directory exists
    if (!existsSync(this.persistPath)) {
      mkdirSync(this.persistPath, { recursive: true });
    }
  }

  /**
   * Publish an event: persist to JSONL and emit to subscribers.
   */
  async publish(event: PipelineEvent): Promise<void> {
    const filePath = join(this.persistPath, `${event.request_id}.jsonl`);
    const line = JSON.stringify(event) + '\n';

    try {
      // Append to JSONL file
      const file = Bun.file(filePath);
      const existing = await file.exists() ? await file.text() : '';
      await Bun.write(filePath, existing + line);
    } catch (err) {
      logger.error({ err, requestId: event.request_id }, 'Failed to persist event');
    }

    this.emit('event', event);
  }

  /**
   * Read all persisted events for a request.
   */
  async getEvents(requestId: string): Promise<PipelineEvent[]> {
    const filePath = join(this.persistPath, `${requestId}.jsonl`);
    const file = Bun.file(filePath);

    if (!(await file.exists())) {
      return [];
    }

    const text = await file.text();
    return text
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as PipelineEvent);
  }
}
