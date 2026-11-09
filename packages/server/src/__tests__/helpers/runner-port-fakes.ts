import type {
  BrowserEventSink,
  BrowserPublication,
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

  async isAvailable(runnerId: string): Promise<boolean> {
    return this.available.has(runnerId);
  }

  async request(runnerId: string, request: RunnerRequest): Promise<RunnerResponse> {
    if (!this.available.has(runnerId)) throw new Error(`Runner ${runnerId} is unavailable`);
    this.requests.push({ runnerId, request });
    return structuredClone(this.response);
  }
}

export class FakeRunnerTerminalPort implements RunnerTerminalPort {
  readonly available = new Set<string>();
  readonly events: Array<{ runnerId: string; userId: string; event: RunnerTerminalEvent }> = [];
  readonly sessions = new Map<string, Array<Record<string, unknown>>>();

  async isAvailable(runnerId: string): Promise<boolean> {
    return this.available.has(runnerId);
  }

  async dispatch(runnerId: string, userId: string, event: RunnerTerminalEvent): Promise<void> {
    if (!this.available.has(runnerId)) throw new Error(`Runner ${runnerId} is unavailable`);
    this.events.push({ runnerId, userId, event });
  }

  async listSessions(runnerId: string, userId: string): Promise<Array<Record<string, unknown>>> {
    return structuredClone(this.sessions.get(`${runnerId}\0${userId}`) ?? []);
  }
}

export class FakeRunnerPresencePort implements RunnerPresencePort {
  readonly owners = new Map<string, string | null>();

  async isAvailable(runnerId: string): Promise<boolean> {
    return this.owners.has(runnerId);
  }

  async userHasAvailableRunner(userId: string): Promise<boolean> {
    return [...this.owners.values()].includes(userId);
  }

  async userIdForRunner(runnerId: string): Promise<string | null> {
    return this.owners.get(runnerId) ?? null;
  }

  async availableRunnerCount(): Promise<number> {
    return this.owners.size;
  }
}

export class FakeBrowserEventSink implements BrowserEventSink {
  readonly publications: BrowserPublication[] = [];
  readonly deliveries: Array<{
    target: 'user' | 'all' | 'thread-stream' | 'thread-presence' | 'thread-viewers' | 'evict';
    id?: string;
    event?: Record<string, unknown>;
  }> = [];

  publish(publication: BrowserPublication): void {
    this.publications.push(publication);
    const { scope } = publication;
    const id = 'userId' in scope ? scope.userId : 'threadId' in scope ? scope.threadId : undefined;
    this.deliveries.push({ target: scope.kind, id, event: publication.legacyEvent });
  }

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
