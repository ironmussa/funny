import type { RunnerPresencePort } from '../runner-ports.js';
import { observeRunnerGrpc } from './transport-observability.js';

export type RunnerGrpcSessionEndReason = 'heartbeat-expired' | 'session-closed' | 'server-shutdown';

export interface RunnerGrpcSessionConnection {
  invalidate(reason: 'heartbeat-expired' | 'session-replaced' | 'server-shutdown'): void;
}

export interface RunnerGrpcSessionRegistryOptions {
  heartbeatTimeoutMs: number;
  initialEpoch?: bigint;
  onAvailable?: (runnerId: string, epoch: bigint, userId: string | null) => void | Promise<void>;
  onHeartbeat?: (runnerId: string, epoch: bigint, userId: string | null) => void | Promise<void>;
  onUnavailable?: (
    runnerId: string,
    epoch: bigint,
    reason: RunnerGrpcSessionEndReason,
    userId: string | null,
  ) => void | Promise<void>;
  onTransitionError?: (error: unknown, runnerId: string) => void | Promise<void>;
}

interface ActiveSession {
  epoch: bigint;
  userId: string | null;
  connection: RunnerGrpcSessionConnection;
  heartbeatTimer: ReturnType<typeof setTimeout>;
}

/**
 * Owns the single active gRPC control session for each authenticated runner.
 * Replacement is synchronous: the new epoch becomes authoritative before the
 * displaced connection is invalidated, so its cleanup cannot mark the new
 * session unavailable.
 */
export class RunnerGrpcSessionRegistry implements RunnerPresencePort {
  private readonly active = new Map<string, ActiveSession>();
  private readonly runnersByUser = new Map<string, Set<string>>();
  private readonly transitions = new Map<string, Promise<void>>();
  private nextEpoch: bigint;

  constructor(private readonly options: RunnerGrpcSessionRegistryOptions) {
    this.nextEpoch = options.initialEpoch ?? 0n;
  }

  activate(
    runnerId: string,
    connection: RunnerGrpcSessionConnection,
    userId: string | null = null,
  ): bigint {
    const previous = this.active.get(runnerId);
    const epoch = ++this.nextEpoch;
    const session: ActiveSession = {
      epoch,
      userId,
      connection,
      heartbeatTimer: this.createHeartbeatTimer(runnerId, epoch),
    };

    if (previous) this.removeFromUserIndex(runnerId, previous.userId);
    this.active.set(runnerId, session);
    this.addToUserIndex(runnerId, userId);
    if (previous) {
      clearTimeout(previous.heartbeatTimer);
      previous.connection.invalidate('session-replaced');
      observeRunnerGrpc({
        event: 'session-replaced',
        streamClass: 'control',
        status: 'replaced',
        runnerId,
        sessionEpoch: epoch,
        reconnectReason: 'session-replaced',
      });
    }
    this.enqueue(runnerId, () => this.options.onAvailable?.(runnerId, epoch, userId));
    return epoch;
  }

  heartbeat(runnerId: string, epoch: bigint): boolean {
    const session = this.active.get(runnerId);
    if (!session || session.epoch !== epoch) return false;

    clearTimeout(session.heartbeatTimer);
    session.heartbeatTimer = this.createHeartbeatTimer(runnerId, epoch);
    this.enqueue(runnerId, () => this.options.onHeartbeat?.(runnerId, epoch, session.userId));
    return true;
  }

  deactivate(
    runnerId: string,
    epoch: bigint,
    reason: RunnerGrpcSessionEndReason = 'session-closed',
  ): boolean {
    const session = this.active.get(runnerId);
    if (!session || session.epoch !== epoch) return false;

    this.active.delete(runnerId);
    this.removeFromUserIndex(runnerId, session.userId);
    clearTimeout(session.heartbeatTimer);
    this.enqueue(runnerId, () =>
      this.options.onUnavailable?.(runnerId, epoch, reason, session.userId),
    );
    return true;
  }

  isActive(runnerId: string, epoch: bigint): boolean {
    return this.active.get(runnerId)?.epoch === epoch;
  }

  activeEpoch(runnerId: string): bigint | null {
    return this.active.get(runnerId)?.epoch ?? null;
  }

  isAvailable(runnerId: string): boolean {
    return this.active.has(runnerId);
  }

  userHasAvailableRunner(userId: string): boolean {
    return (this.runnersByUser.get(userId)?.size ?? 0) > 0;
  }

  userIdForRunner(runnerId: string): string | null {
    return this.active.get(runnerId)?.userId ?? null;
  }

  availableRunnerCount(): number {
    return this.active.size;
  }

  closeAll(reason: 'server-shutdown' = 'server-shutdown'): void {
    for (const [runnerId, session] of this.active) {
      this.active.delete(runnerId);
      this.removeFromUserIndex(runnerId, session.userId);
      clearTimeout(session.heartbeatTimer);
      this.enqueue(runnerId, () =>
        this.options.onUnavailable?.(runnerId, session.epoch, reason, session.userId),
      );
      session.connection.invalidate(reason);
    }
  }

  async whenIdle(runnerId: string): Promise<void> {
    await this.transitions.get(runnerId);
  }

  private createHeartbeatTimer(runnerId: string, epoch: bigint): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      const session = this.active.get(runnerId);
      if (!session || session.epoch !== epoch) return;

      this.active.delete(runnerId);
      this.removeFromUserIndex(runnerId, session.userId);
      this.enqueue(runnerId, () =>
        this.options.onUnavailable?.(runnerId, epoch, 'heartbeat-expired', session.userId),
      );
      session.connection.invalidate('heartbeat-expired');
      observeRunnerGrpc({
        event: 'heartbeat-expired',
        streamClass: 'control',
        status: 'expired',
        runnerId,
        sessionEpoch: epoch,
        reconnectReason: 'heartbeat-expired',
      });
    }, this.options.heartbeatTimeoutMs);
    timer.unref();
    return timer;
  }

  private enqueue(runnerId: string, transition: () => void | Promise<void>): void {
    const previous = this.transitions.get(runnerId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(transition)
      .catch((error) => this.options.onTransitionError?.(error, runnerId))
      .catch(() => undefined)
      .then(() => undefined);
    this.transitions.set(runnerId, next);
    void next.finally(() => {
      if (this.transitions.get(runnerId) === next) this.transitions.delete(runnerId);
    });
  }

  private addToUserIndex(runnerId: string, userId: string | null): void {
    if (!userId) return;
    const runners = this.runnersByUser.get(userId) ?? new Set<string>();
    runners.add(runnerId);
    this.runnersByUser.set(userId, runners);
  }

  private removeFromUserIndex(runnerId: string, userId: string | null): void {
    if (!userId) return;
    const runners = this.runnersByUser.get(userId);
    if (!runners) return;
    runners.delete(runnerId);
    if (runners.size === 0) this.runnersByUser.delete(userId);
  }
}
