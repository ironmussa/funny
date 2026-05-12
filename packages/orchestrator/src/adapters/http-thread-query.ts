/**
 * @domain subdomain: Orchestration
 * @domain subdomain-type: core
 * @domain type: adapter
 * @domain layer: infrastructure
 *
 * HTTP-backed `ThreadQueryAdapter`. Mirrors the in-process SQL adapter
 * (`createDefaultThreadQuery` on the server) by calling
 * `/api/orchestrator/system/{candidates,terminal-thread-ids,threads/:id}`.
 */

import type { Thread } from '@funny/shared';

import type { ThreadQueryAdapter } from '../service.js';
import type { HttpOrchestratorClient } from './http-client.js';

export class HttpThreadQueryAdapter implements ThreadQueryAdapter {
  constructor(private readonly client: HttpOrchestratorClient) {}

  async listEligibleCandidates(): Promise<Thread[]> {
    const res = await this.client.get<{ threads: Thread[] }>('/candidates');
    return res.threads;
  }

  async listTerminalThreadIds(): Promise<Set<string>> {
    const res = await this.client.get<{ ids: string[] }>('/terminal-thread-ids');
    return new Set(res.ids);
  }

  async getThreadById(id: string): Promise<Thread | null> {
    const res = await this.client.get<{ thread: Thread | null }>(
      `/threads/${encodeURIComponent(id)}`,
    );
    return res.thread;
  }
}
