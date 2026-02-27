/**
 * IngestWebhookAdapter — forwards all EventBus events to the main
 * server's ingest webhook endpoint so they appear in the UI.
 *
 * Uses @funny/funny-client under the hood for HTTP communication.
 *
 * Env vars:
 *   INGEST_WEBHOOK_URL    — Base URL of the funny server (default: http://localhost:3001)
 *   INGEST_WEBHOOK_SECRET — Shared secret for X-Webhook-Secret header
 *
 * The adapter is a simple fire-and-forget forwarder: if the webhook
 * is unreachable the event is logged and dropped (the JSONL persistence
 * in EventBus still retains it on disk).
 */

import { FunnyClient, FunnyClientError } from '@funny/funny-client';

import type { PipelineEvent } from '../../core/types.js';
import type { EventBus } from '../../infrastructure/event-bus.js';
import { logger } from '../../infrastructure/logger.js';

const DEFAULT_BASE_URL = 'http://localhost:3001';

export interface IngestWebhookAdapterOptions {
  /** Base URL of the funny server (e.g. "http://localhost:3001") */
  baseUrl?: string;
  secret?: string;
  timeoutMs?: number;
}

export class IngestWebhookAdapter {
  private client: FunnyClient;
  private unsubscribe: (() => void) | null = null;

  constructor(
    private eventBus: EventBus,
    opts?: IngestWebhookAdapterOptions,
  ) {
    const baseUrl =
      opts?.baseUrl ?? this.extractBaseUrl(process.env.INGEST_WEBHOOK_URL) ?? DEFAULT_BASE_URL;
    const secret = opts?.secret ?? process.env.INGEST_WEBHOOK_SECRET ?? '';

    this.client = new FunnyClient({
      baseUrl,
      secret,
      timeoutMs: opts?.timeoutMs ?? 10_000,
    });
  }

  /** Start forwarding events. */
  start(): void {
    if (this.unsubscribe) return;

    const handler = (event: PipelineEvent) => {
      this.forward(event).catch((err) => {
        logger.warn(
          { err: err.message, eventType: event.event_type },
          'Ingest webhook forward failed',
        );
      });
    };

    this.eventBus.on('event', handler);
    this.unsubscribe = () => this.eventBus.off('event', handler);

    logger.info('Ingest webhook adapter started (using FunnyClient)');
  }

  /** Stop forwarding events. */
  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /** Expose the underlying FunnyClient for direct use. */
  getClient(): FunnyClient {
    return this.client;
  }

  private async forward(event: PipelineEvent): Promise<void> {
    try {
      await this.client.send({
        event_type: event.event_type,
        request_id: event.request_id,
        timestamp: event.timestamp,
        data: event.data,
        metadata: event.metadata,
      });
    } catch (err) {
      if (err instanceof FunnyClientError) {
        logger.warn(
          { status: err.statusCode, error: err.message, eventType: event.event_type },
          'Ingest webhook returned non-OK',
        );
      } else {
        throw err;
      }
    }
  }

  /**
   * Extract base URL from a full webhook URL.
   * e.g. "http://localhost:3001/api/ingest/webhook" → "http://localhost:3001"
   */
  private extractBaseUrl(url?: string): string | undefined {
    if (!url) return undefined;
    try {
      const parsed = new URL(url);
      return `${parsed.protocol}//${parsed.host}`;
    } catch {
      return url;
    }
  }
}
