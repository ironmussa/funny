/**
 * EventBus — publish PipelineEvents with JSONL persistence.
 *
 * Uses eventemitter3 for typed, fast in-memory pub/sub.
 * Persists events to {EVENTS_PATH}/{request_id}.jsonl via Bun.write().
 */

import { mkdirSync, existsSync } from 'fs';
import { appendFile } from 'fs/promises';
import { join } from 'path';

import EventEmitter from 'eventemitter3';

import type { PipelineEvent, PipelineEventType } from '../core/types.js';
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
      await appendFile(filePath, line, 'utf-8');
    } catch (err) {
      logger.error({ err, requestId: event.request_id }, 'Failed to persist event');
    }

    this.emit('event', event);
  }

  /**
   * Subscribe to a specific event type. Returns an unsubscribe function.
   */
  onEventType(eventType: PipelineEventType, handler: (event: PipelineEvent) => void): () => void {
    const wrappedHandler = (event: PipelineEvent) => {
      if (event.event_type === eventType) handler(event);
    };
    this.on('event', wrappedHandler);
    return () => this.off('event', wrappedHandler);
  }

  /**
   * Subscribe to multiple event types with a single handler. Returns an unsubscribe function.
   */
  onEventTypes(
    eventTypes: PipelineEventType[],
    handler: (event: PipelineEvent) => void,
  ): () => void {
    const typeSet = new Set(eventTypes);
    const wrappedHandler = (event: PipelineEvent) => {
      if (typeSet.has(event.event_type)) handler(event);
    };
    this.on('event', wrappedHandler);
    return () => this.off('event', wrappedHandler);
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
