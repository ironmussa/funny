/**
 * FunnyClient — sends events to the funny server ingest webhook.
 *
 * Usage:
 *   const client = new FunnyClient({
 *     baseUrl: 'http://localhost:3001',
 *     secret: 'my-webhook-secret',
 *   });
 *
 *   // Start a new pipeline thread
 *   const { thread_id } = await client.accepted('req-1', {
 *     projectId: 'proj-abc',
 *     branch: 'feat/new-thing',
 *     prompt: 'Implement the feature',
 *   });
 *
 *   // Send a message
 *   await client.message('req-1', 'Processing step 1...');
 *
 *   // Send CLI messages for rich rendering
 *   await client.cliMessage('req-1', {
 *     type: 'assistant',
 *     message: { id: 'msg-1', content: [{ type: 'text', text: 'Working on it...' }] },
 *   });
 *
 *   // Complete
 *   await client.completed('req-1', { cost_usd: 0.05 });
 */

import type {
  FunnyClientConfig,
  IngestEvent,
  PipelineEventType,
  WebhookResponse,
  WebhookErrorResponse,
  CLIMessage,
} from './types.js';

export class FunnyClient {
  private baseUrl: string;
  private secret: string;
  private timeoutMs: number;

  constructor(config: FunnyClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.secret = config.secret;
    this.timeoutMs = config.timeoutMs ?? 10_000;
  }

  // ── Core send method ────────────────────────────────────────

  /**
   * Send a raw event to the ingest webhook.
   */
  async send(event: IngestEvent): Promise<WebhookResponse> {
    const url = `${this.baseUrl}/api/ingest/webhook`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Secret': this.secret,
      },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as WebhookErrorResponse;
      throw new FunnyClientError(
        body.error ?? `HTTP ${response.status} ${response.statusText}`,
        response.status,
      );
    }

    return response.json() as Promise<WebhookResponse>;
  }

  // ── Lifecycle methods ───────────────────────────────────────

  /**
   * Signal that a pipeline request has been accepted.
   * Creates a new thread in the UI.
   */
  async accepted(
    requestId: string,
    data: {
      projectId?: string;
      branch?: string;
      base_branch?: string;
      worktree_path?: string;
      prompt?: string;
      title?: string;
      model?: string;
    },
    metadata?: Record<string, unknown>,
  ): Promise<WebhookResponse> {
    return this.send({
      event_type: 'pipeline.accepted',
      request_id: requestId,
      timestamp: now(),
      data,
      metadata,
    });
  }

  /**
   * Signal that the pipeline has started running.
   */
  async started(
    requestId: string,
    data?: Record<string, unknown>,
    metadata?: Record<string, unknown>,
  ): Promise<WebhookResponse> {
    return this.send({
      event_type: 'pipeline.started',
      request_id: requestId,
      timestamp: now(),
      data: data ?? {},
      metadata,
    });
  }

  /**
   * Signal that the pipeline completed successfully.
   */
  async completed(
    requestId: string,
    data?: { cost_usd?: number; duration_ms?: number; [key: string]: unknown },
    metadata?: Record<string, unknown>,
  ): Promise<WebhookResponse> {
    return this.send({
      event_type: 'pipeline.completed',
      request_id: requestId,
      timestamp: now(),
      data: data ?? {},
      metadata,
    });
  }

  /**
   * Signal that the pipeline failed.
   */
  async failed(
    requestId: string,
    data?: { error?: string; cost_usd?: number; [key: string]: unknown },
    metadata?: Record<string, unknown>,
  ): Promise<WebhookResponse> {
    return this.send({
      event_type: 'pipeline.failed',
      request_id: requestId,
      timestamp: now(),
      data: data ?? {},
      metadata,
    });
  }

  /**
   * Signal that the pipeline was stopped.
   */
  async stopped(
    requestId: string,
    data?: Record<string, unknown>,
    metadata?: Record<string, unknown>,
  ): Promise<WebhookResponse> {
    return this.send({
      event_type: 'pipeline.stopped',
      request_id: requestId,
      timestamp: now(),
      data: data ?? {},
      metadata,
    });
  }

  // ── Message methods ─────────────────────────────────────────

  /**
   * Send a simple text message (rendered as a system message in the UI).
   */
  async message(
    requestId: string,
    content: string,
    options?: { threadId?: string; metadata?: Record<string, unknown> },
  ): Promise<WebhookResponse> {
    return this.send({
      event_type: 'pipeline.message',
      request_id: requestId,
      thread_id: options?.threadId,
      timestamp: now(),
      data: { content },
      metadata: options?.metadata,
    });
  }

  /**
   * Send a CLI message for rich rendering (assistant text, tool calls, results).
   * This mirrors the Claude CLI NDJSON stream format.
   *
   * Common `cli_message` shapes:
   *
   * System init:
   *   { type: 'system', subtype: 'init', session_id: '...', tools: [...], cwd: '...' }
   *
   * Assistant text:
   *   { type: 'assistant', message: { id: 'msg-1', content: [{ type: 'text', text: '...' }] } }
   *
   * Assistant tool use:
   *   { type: 'assistant', message: { id: 'msg-1', content: [{ type: 'tool_use', id: 'tu-1', name: 'Read', input: {...} }] } }
   *
   * Tool result:
   *   { type: 'user', message: { id: 'msg-2', content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: '...' }] } }
   *
   * Final result:
   *   { type: 'result', result: '...', cost_usd: 0.05, duration_ms: 3000, session_id: '...' }
   */
  async cliMessage(
    requestId: string,
    cliMessage: Record<string, unknown>,
    options?: { threadId?: string; metadata?: Record<string, unknown> },
  ): Promise<WebhookResponse> {
    return this.send({
      event_type: 'pipeline.cli_message',
      request_id: requestId,
      thread_id: options?.threadId,
      timestamp: now(),
      data: { cli_message: cliMessage },
      metadata: options?.metadata,
    });
  }

  // ── Convenience CLI message helpers ─────────────────────────

  /**
   * Send a system init CLI message (marks thread as running, sets tools/cwd).
   */
  async cliInit(
    requestId: string,
    init: { session_id: string; tools?: string[]; cwd?: string; model?: string },
    options?: { threadId?: string },
  ): Promise<WebhookResponse> {
    return this.cliMessage(requestId, {
      type: 'system',
      subtype: 'init',
      ...init,
    }, options);
  }

  /**
   * Send assistant text as a CLI message.
   */
  async cliText(
    requestId: string,
    messageId: string,
    text: string,
    options?: { threadId?: string },
  ): Promise<WebhookResponse> {
    return this.cliMessage(requestId, {
      type: 'assistant',
      message: {
        id: messageId,
        content: [{ type: 'text', text }],
      },
    }, options);
  }

  /**
   * Send a tool use as a CLI message.
   */
  async cliToolUse(
    requestId: string,
    messageId: string,
    toolUse: { id: string; name: string; input: Record<string, unknown> },
    options?: { threadId?: string },
  ): Promise<WebhookResponse> {
    return this.cliMessage(requestId, {
      type: 'assistant',
      message: {
        id: messageId,
        content: [{ type: 'tool_use', ...toolUse }],
      },
    }, options);
  }

  /**
   * Send a tool result as a CLI message.
   */
  async cliToolResult(
    requestId: string,
    messageId: string,
    toolResult: { tool_use_id: string; content: string; is_error?: boolean },
    options?: { threadId?: string },
  ): Promise<WebhookResponse> {
    return this.cliMessage(requestId, {
      type: 'user',
      message: {
        id: messageId,
        content: [{ type: 'tool_result', ...toolResult }],
      },
    }, options);
  }

  /**
   * Send a final result CLI message (marks thread as completed).
   */
  async cliResult(
    requestId: string,
    result: { result: string; cost_usd?: number; duration_ms?: number; session_id?: string },
    options?: { threadId?: string },
  ): Promise<WebhookResponse> {
    return this.cliMessage(requestId, {
      type: 'result',
      ...result,
    }, options);
  }

  // ── Generic event method ────────────────────────────────────

  /**
   * Send any event type (for custom/advanced use cases).
   */
  async emit(
    eventType: PipelineEventType | string,
    requestId: string,
    data: Record<string, unknown>,
    options?: { threadId?: string; metadata?: Record<string, unknown> },
  ): Promise<WebhookResponse> {
    return this.send({
      event_type: eventType,
      request_id: requestId,
      thread_id: options?.threadId,
      timestamp: now(),
      data,
      metadata: options?.metadata,
    });
  }
}

// ── Error class ───────────────────────────────────────────────

export class FunnyClientError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = 'FunnyClientError';
    this.statusCode = statusCode;
  }
}

// ── Helpers ───────────────────────────────────────────────────

function now(): string {
  return new Date().toISOString();
}
