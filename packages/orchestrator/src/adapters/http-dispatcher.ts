/**
 * @domain subdomain: Orchestration
 * @domain subdomain-type: core
 * @domain type: adapter
 * @domain layer: infrastructure
 *
 * `Dispatcher` implementation backed by HTTP. Two responsibilities:
 *   1. POST `/api/orchestrator/system/dispatch` to kick off a pipeline run
 *      on the user's runner via the server tunnel — get back `pipelineRunId`.
 *   2. Subscribe to `HttpEventStream` for that thread's terminal event
 *      so the `finished` Promise resolves.
 *
 * Mirrors the in-process `PipelineDispatchTunnelAdapter` interface 1:1
 * so the brain code (OrchestratorService) doesn't change.
 */

import type { Thread } from '@funny/shared';

import type {
  DispatchHandle,
  DispatchOutcome,
  DispatchResult,
  Dispatcher,
  OrchestratorLogger,
} from '../service.js';
import type { HttpOrchestratorClient } from './http-client.js';
import type { HttpEventStream } from './http-event-stream.js';

export interface HttpDispatcherOptions {
  client: HttpOrchestratorClient;
  eventStream: HttpEventStream;
  log: OrchestratorLogger;
  /** Optional pipeline name override. Defaults to runner-side default. */
  pipelineName?: string | null;
}

const NS = 'http-dispatcher';

interface DispatchResponseBody {
  ok?: boolean;
  pipelineRunId?: string;
  error?: { message?: string };
}

function pickPrompt(thread: Thread): string {
  return thread.initialPrompt?.trim() || thread.title?.trim() || 'Continue.';
}

export class HttpDispatcher implements Dispatcher {
  private readonly client: HttpOrchestratorClient;
  private readonly events: HttpEventStream;
  private readonly log: OrchestratorLogger;
  private readonly pipelineName: string | null;

  constructor(opts: HttpDispatcherOptions) {
    this.client = opts.client;
    this.events = opts.eventStream;
    this.log = opts.log;
    this.pipelineName = opts.pipelineName ?? null;
  }

  async dispatch(thread: Thread): Promise<DispatchResult> {
    const payload: Record<string, unknown> = {
      threadId: thread.id,
      userId: thread.userId,
      prompt: pickPrompt(thread),
    };
    if (this.pipelineName) payload.pipelineName = this.pipelineName;

    let response: DispatchResponseBody;
    try {
      response = await this.client.post<DispatchResponseBody>('/dispatch', payload);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.warn('HTTP dispatch failed', {
        namespace: NS,
        threadId: thread.id,
        error: message,
      });
      return { ok: false, error: { message } };
    }

    if (!response.ok || !response.pipelineRunId) {
      const message = response.error?.message ?? 'dispatch returned ok=false without pipelineRunId';
      return { ok: false, error: { message } };
    }

    return { ok: true, handle: this.buildHandle(thread, response.pipelineRunId) };
  }

  private buildHandle(thread: Thread, pipelineRunId: string): DispatchHandle {
    let resolveFinished!: (outcome: DispatchOutcome) => void;
    const finished = new Promise<DispatchOutcome>((resolve) => {
      resolveFinished = resolve;
    });

    let settled = false;
    const settle = (outcome: DispatchOutcome): void => {
      if (settled) return;
      settled = true;
      try {
        unsubscribe();
      } catch {
        // ignore
      }
      resolveFinished(outcome);
    };

    const unsubscribe = this.events.subscribe(thread.id, (event) => {
      if (event.kind !== 'agent_terminal') return;
      const kind = event.payload.kind as string | undefined;
      const error = event.payload.error as string | undefined;
      if (kind === 'completed') settle({ kind: 'completed' });
      else if (kind === 'stopped') settle({ kind: 'cancelled' });
      else settle({ kind: 'failed', error: error ?? 'agent failed' });
    });

    const abort = (): void => {
      if (settled) return;
      void this.client
        .post(`/cancel/${encodeURIComponent(pipelineRunId)}`, { userId: thread.userId })
        .catch((err) => {
          this.log.warn('HTTP cancel call failed', {
            namespace: NS,
            threadId: thread.id,
            pipelineRunId,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      settle({ kind: 'cancelled' });
    };

    return {
      pipelineRunId,
      abort,
      finished,
    };
  }
}
