/**
 * @domain subdomain: Orchestration
 * @domain subdomain-type: core
 * @domain type: adapter
 * @domain layer: infrastructure
 *
 * HTTP-backed `SchedulerRunRepository` implementation. Every method
 * is a single fetch against `/api/scheduler/system/{runs|dependencies}/...`
 * mirroring the in-process repo signatures so the brain code is identical
 * across transports.
 *
 * Errors propagate as thrown — the brain wraps them in try/catch for
 * "claim race" detection (the in-process implementation also throws on
 * unique-PK violation).
 */

import type {
  ClaimArgs,
  SchedulerRunRepository,
  SchedulerRunRow,
} from '@funny/shared/repositories';

import { HttpClientError, type HttpSchedulerClient } from './http-client.js';

export class HttpSchedulerRunRepository implements SchedulerRunRepository {
  constructor(private readonly client: HttpSchedulerClient) {}

  async claim(args: ClaimArgs): Promise<SchedulerRunRow> {
    try {
      const res = await this.client.post<{ run: SchedulerRunRow }>('/runs', args);
      return res.run;
    } catch (err) {
      // Server returns 409 on unique-PK race; surface as a regular error so
      // the brain's existing try/catch in `claimAndDispatch` handles it.
      if (err instanceof HttpClientError && err.status === 409) {
        throw new Error(err.body ?? 'unique violation', { cause: err });
      }
      throw err;
    }
  }

  async release(threadId: string): Promise<void> {
    await this.client.del(`/runs/${encodeURIComponent(threadId)}`);
  }

  async getRun(threadId: string): Promise<SchedulerRunRow | undefined> {
    const res = await this.client.get<{ run: SchedulerRunRow | null }>(
      `/runs/${encodeURIComponent(threadId)}`,
    );
    return res.run ?? undefined;
  }

  async listActiveRuns(): Promise<SchedulerRunRow[]> {
    const res = await this.client.get<{ runs: SchedulerRunRow[] }>('/runs');
    return res.runs;
  }

  async listActiveRunsByUser(userId: string): Promise<SchedulerRunRow[]> {
    // No dedicated endpoint — filter client-side. This is a read-only path
    // used by the per-user UI today; the brain itself doesn't call this.
    const all = await this.listActiveRuns();
    return all.filter((r) => r.userId === userId);
  }

  async claimedThreadIds(): Promise<string[]> {
    const all = await this.listActiveRuns();
    return all.map((r) => r.threadId);
  }

  async setPipelineRunId(threadId: string, pipelineRunId: string): Promise<void> {
    await this.client.patch(`/runs/${encodeURIComponent(threadId)}`, {
      setPipelineRunId: pipelineRunId,
    });
  }

  async setRetry(args: {
    threadId: string;
    attempt: number;
    nextRetryAtMs: number;
    lastError: string;
  }): Promise<void> {
    await this.client.patch(`/runs/${encodeURIComponent(args.threadId)}`, {
      setRetry: {
        attempt: args.attempt,
        nextRetryAtMs: args.nextRetryAtMs,
        lastError: args.lastError,
      },
    });
  }

  async touchLastEvent(threadId: string, lastEventAtMs: number): Promise<void> {
    await this.client.patch(`/runs/${encodeURIComponent(threadId)}`, {
      touchLastEvent: lastEventAtMs,
    });
  }

  async addTokens(threadId: string, delta: number): Promise<void> {
    if (delta <= 0) return;
    await this.client.patch(`/runs/${encodeURIComponent(threadId)}`, { addTokens: delta });
  }

  async listDueRetries(now: number): Promise<SchedulerRunRow[]> {
    const res = await this.client.get<{ runs: SchedulerRunRow[] }>('/runs/due-retries', {
      now,
    });
    return res.runs;
  }

  async addDependency(threadId: string, blockedBy: string): Promise<void> {
    await this.client.post('/dependencies', { threadId, blockedBy });
  }

  async removeDependency(threadId: string, blockedBy: string): Promise<void> {
    await this.client.del('/dependencies', { threadId, blockedBy });
  }

  async listDependenciesFor(threadIds: string[]): Promise<Map<string, string[]>> {
    if (threadIds.length === 0) return new Map();
    const res = await this.client.get<{ dependencies: Record<string, string[]> }>('/dependencies', {
      threadIds: threadIds.join(','),
    });
    return new Map(Object.entries(res.dependencies));
  }
}
