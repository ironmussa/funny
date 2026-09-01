import type {
  BrowserEventSink,
  RunnerPresencePort,
  RunnerRequest,
  RunnerRequestPort,
  RunnerResponse,
  RunnerTerminalEvent,
  RunnerTerminalPort,
} from '../../services/runner-ports.js';

export class FakeRunnerRequestPort implements RunnerRequestPort {
  readonly requests: Array<{ runnerId: string; request: RunnerRequest }> = [];
  readonly available = new Set<string>();
  response: RunnerResponse = { status: 200, headers: {}, body: '', bodyEncoding: 'utf8' };

  isAvailable(runnerId: string): boolean {
    return this.available.has(runnerId);
  }

  async request(runnerId: string, request: RunnerRequest): Promise<RunnerResponse> {
    if (!this.isAvailable(runnerId)) throw new Error(`Runner ${runnerId} is unavailable`);
    this.requests.push({ runnerId, request });
    return structuredClone(this.response);
  }
}

export class FakeRunnerTerminalPort implements RunnerTerminalPort {
  readonly available = new Set<string>();
  readonly events: Array<{ runnerId: string; userId: string; event: RunnerTerminalEvent }> = [];
  readonly sessions = new Map<string, Array<Record<string, unknown>>>();

  isAvailable(runnerId: string): boolean {
    return this.available.has(runnerId);
  }

  dispatch(runnerId: string, userId: string, event: RunnerTerminalEvent): void {
    if (!this.isAvailable(runnerId)) throw new Error(`Runner ${runnerId} is unavailable`);
    this.events.push({ runnerId, userId, event });
  }

  listSessions(runnerId: string, userId: string): Array<Record<string, unknown>> {
    return structuredClone(this.sessions.get(`${runnerId}\0${userId}`) ?? []);
  }
}

export class FakeRunnerPresencePort implements RunnerPresencePort {
  readonly owners = new Map<string, string | null>();

  isAvailable(runnerId: string): boolean {
    return this.owners.has(runnerId);
  }

  userHasAvailableRunner(userId: string): boolean {
    return [...this.owners.values()].includes(userId);
  }

  userIdForRunner(runnerId: string): string | null {
    return this.owners.get(runnerId) ?? null;
  }

  availableRunnerCount(): number {
    return this.owners.size;
  }
}

export class FakeBrowserEventSink implements BrowserEventSink {
  readonly deliveries: Array<{
    target: 'user' | 'all' | 'thread-stream' | 'thread-presence' | 'thread-viewers' | 'evict';
    id?: string;
    event?: Record<string, unknown>;
  }> = [];

  toUser(userId: string, event: Record<string, unknown>): void {
    this.deliveries.push({ target: 'user', id: userId, event });
  }
  toAll(event: Record<string, unknown>): void {
    this.deliveries.push({ target: 'all', event });
  }
  toThreadStream(threadId: string, event: Record<string, unknown>): void {
    this.deliveries.push({ target: 'thread-stream', id: threadId, event });
  }
  toThreadPresence(threadId: string, event: Record<string, unknown>): void {
    this.deliveries.push({ target: 'thread-presence', id: threadId, event });
  }
  toThreadViewers(threadId: string, event: Record<string, unknown>): void {
    this.deliveries.push({ target: 'thread-viewers', id: threadId, event });
  }
  evictFromThread(userId: string, threadId: string): void {
    this.deliveries.push({ target: 'evict', id: `${userId}\0${threadId}` });
  }
}
