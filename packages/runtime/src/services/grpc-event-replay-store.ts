import { Database } from 'bun:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { parseStoredJson } from '@funny/shared/json-validation';
import { canonicalJson } from '@funny/shared/lib/canonical-json';
import { EventDurability } from '@funny/shared/runner-v2/events';
import { z } from 'zod';

import { DATA_DIR } from '../lib/data-dir.js';

export interface GrpcEventScope {
  threadId: string;
  executionId: string;
}

export interface GrpcReplayEvent {
  scope: GrpcEventScope;
  sequence: bigint;
  eventType: string;
  data: unknown;
  durability: number;
  occurredAt: string;
}

export interface GrpcEventReplayPage {
  events: GrpcReplayEvent[];
  earliestAvailableSequence: bigint;
  latestSequence: bigint;
  historyAvailable: boolean;
}

export interface GrpcPendingEventScope extends GrpcEventScope {
  hasTerminalEvent: boolean;
  earliestSequence: bigint;
}

interface ScopeRow {
  thread_id: string;
  execution_id: string;
  next_sequence: number;
  acknowledged_sequence: number;
  trimmed_through_sequence: number;
  terminal_sequence: number | null;
}

interface EventRow {
  thread_id: string;
  execution_id: string;
  sequence: number;
  event_type: string;
  data_json: string;
  durability: number;
  occurred_at: string;
}

const durableEventDataSchema = z.record(z.string(), z.unknown());
const terminalEventTypes = new Set(['agent:error', 'agent:result']);

function validateScope(scope: GrpcEventScope): void {
  if (!scope.threadId || !scope.executionId) {
    throw new Error('event replay scope requires thread and execution IDs');
  }
}

function serialize(row: EventRow): GrpcReplayEvent {
  const data = parseStoredJson(durableEventDataSchema, row.data_json, 'gRPC replay event data');
  if (!data.ok) throw new Error(data.error);
  return {
    scope: { threadId: row.thread_id, executionId: row.execution_id },
    sequence: BigInt(row.sequence),
    eventType: row.event_type,
    data: data.value,
    durability: row.durability,
    occurredAt: row.occurred_at,
  };
}

/**
 * Runner-local durable replay log. Sequence allocation, insertion, and pruning
 * share one SQLite transaction so a process restart cannot reuse a sequence.
 */
export class GrpcEventReplayStore {
  private readonly database: Database;
  private readonly maxEventsPerScope: number;
  private readonly maxBytesPerScope: number;
  private readonly terminalReserveEvents: number;
  private readonly terminalReserveBytes: number;

  constructor(
    path = resolve(DATA_DIR, 'runner-grpc-events.db'),
    options: {
      maxEventsPerScope?: number;
      maxBytesPerScope?: number;
      terminalReserveEvents?: number;
      terminalReserveBytes?: number;
    } = {},
  ) {
    this.maxEventsPerScope = options.maxEventsPerScope ?? 10_000;
    this.maxBytesPerScope = options.maxBytesPerScope ?? 8 * 1024 * 1024;
    this.terminalReserveEvents = options.terminalReserveEvents ?? 16;
    this.terminalReserveBytes = options.terminalReserveBytes ?? 1024 * 1024;
    if (!Number.isSafeInteger(this.maxEventsPerScope) || this.maxEventsPerScope <= 0) {
      throw new Error('event replay count limit must be positive');
    }
    if (!Number.isSafeInteger(this.maxBytesPerScope) || this.maxBytesPerScope <= 0) {
      throw new Error('event replay byte limit must be positive');
    }
    if (!Number.isSafeInteger(this.terminalReserveEvents) || this.terminalReserveEvents <= 0) {
      throw new Error('terminal event reserve count must be positive');
    }
    if (!Number.isSafeInteger(this.terminalReserveBytes) || this.terminalReserveBytes <= 0) {
      throw new Error('terminal event reserve byte limit must be positive');
    }

    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.database = new Database(path, { create: true, strict: true });
    this.database.exec('PRAGMA journal_mode = WAL');
    this.database.exec('PRAGMA synchronous = FULL');
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS grpc_event_scopes (
        thread_id TEXT NOT NULL,
        execution_id TEXT NOT NULL UNIQUE,
        next_sequence INTEGER NOT NULL,
        acknowledged_sequence INTEGER NOT NULL DEFAULT 0,
        trimmed_through_sequence INTEGER NOT NULL DEFAULT 0,
        terminal_sequence INTEGER,
        PRIMARY KEY (thread_id, execution_id)
      );
      CREATE TABLE IF NOT EXISTS grpc_event_replay (
        thread_id TEXT NOT NULL,
        execution_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        data_json TEXT NOT NULL,
        durability INTEGER NOT NULL,
        occurred_at TEXT NOT NULL,
        byte_size INTEGER NOT NULL,
        PRIMARY KEY (thread_id, execution_id, sequence)
      );
      CREATE INDEX IF NOT EXISTS idx_grpc_event_replay_scope_sequence
      ON grpc_event_replay (thread_id, execution_id, sequence)
    `);
    const scopeColumns = this.database
      .query<{ name: string }, []>('PRAGMA table_info(grpc_event_scopes)')
      .all();
    if (!scopeColumns.some((column) => column.name === 'terminal_sequence')) {
      this.database.exec('ALTER TABLE grpc_event_scopes ADD COLUMN terminal_sequence INTEGER');
      this.database.exec(`
        UPDATE grpc_event_scopes
        SET terminal_sequence = (
          SELECT MAX(sequence)
          FROM grpc_event_replay
          WHERE grpc_event_replay.thread_id = grpc_event_scopes.thread_id
            AND grpc_event_replay.execution_id = grpc_event_scopes.execution_id
            AND grpc_event_replay.durability = ${EventDurability.TERMINAL}
        )
      `);
    }
    if (path !== ':memory:') chmodSync(path, 0o600);
  }

  append(input: {
    scope: GrpcEventScope;
    eventType: string;
    data: Record<string, unknown>;
    durability: number;
    occurredAt?: string;
  }): GrpcReplayEvent {
    validateScope(input.scope);
    if (!input.eventType) throw new Error('event type is required');
    const isTerminalType = terminalEventTypes.has(input.eventType);
    const hasTerminalDurability = input.durability === EventDurability.TERMINAL;
    if (isTerminalType !== hasTerminalDurability) {
      throw new Error('agent result/error events must use terminal durability exclusively');
    }
    const dataJson = canonicalJson(input.data);
    const occurredAt = input.occurredAt ?? new Date().toISOString();
    const byteSize = Buffer.byteLength(input.eventType) + Buffer.byteLength(dataJson) + 32;
    if (input.durability === EventDurability.TERMINAL && byteSize > this.terminalReserveBytes) {
      throw new Error('terminal event exceeds its reserved replay capacity');
    }

    return this.database.transaction(() => {
      const existing = this.scope(input.scope.executionId);
      if (existing && existing.thread_id !== input.scope.threadId) {
        throw new Error('execution ID is already assigned to another thread');
      }
      if (!existing) {
        this.database
          .query(
            `INSERT INTO grpc_event_scopes
              (thread_id, execution_id, next_sequence)
             VALUES (?, ?, 1)`,
          )
          .run(input.scope.threadId, input.scope.executionId);
      }
      const current = this.scope(input.scope.executionId)!;
      if (current.terminal_sequence !== null) {
        throw new Error('event execution already has a terminal event');
      }
      const sequence = current.next_sequence;
      this.database
        .query(
          `INSERT INTO grpc_event_replay
            (thread_id, execution_id, sequence, event_type, data_json, durability, occurred_at, byte_size)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.scope.threadId,
          input.scope.executionId,
          sequence,
          input.eventType,
          dataJson,
          input.durability,
          occurredAt,
          byteSize,
        );
      this.database
        .query(
          `UPDATE grpc_event_scopes
           SET next_sequence = ?,
               terminal_sequence = CASE WHEN ? = ? THEN ? ELSE terminal_sequence END
           WHERE thread_id = ? AND execution_id = ?`,
        )
        .run(
          sequence + 1,
          input.durability,
          EventDurability.TERMINAL,
          sequence,
          input.scope.threadId,
          input.scope.executionId,
        );
      this.prune(input.scope);
      return {
        scope: input.scope,
        sequence: BigInt(sequence),
        eventType: input.eventType,
        data: input.data,
        durability: input.durability,
        occurredAt,
      };
    })();
  }

  acknowledge(scope: GrpcEventScope, highestContiguousSequence: bigint): boolean {
    validateScope(scope);
    const value = Number(highestContiguousSequence);
    if (!Number.isSafeInteger(value) || value < 0)
      throw new Error('invalid event receipt sequence');
    return this.database.transaction(() => {
      const current = this.scope(scope.executionId);
      if (!current || current.thread_id !== scope.threadId) return false;
      if (value >= current.next_sequence)
        throw new Error('event receipt exceeds the sent sequence');
      if (value <= current.acknowledged_sequence) return false;
      this.database
        .query(
          `UPDATE grpc_event_scopes SET acknowledged_sequence = ?
           WHERE thread_id = ? AND execution_id = ?`,
        )
        .run(value, scope.threadId, scope.executionId);
      this.database
        .query(
          `DELETE FROM grpc_event_replay
           WHERE thread_id = ? AND execution_id = ? AND sequence <= ?`,
        )
        .run(scope.threadId, scope.executionId, value);
      return true;
    })();
  }

  replay(scope: GrpcEventScope, afterSequence: bigint, limit = 100): GrpcEventReplayPage {
    validateScope(scope);
    const after = Number(afterSequence);
    if (!Number.isSafeInteger(after) || after < 0) throw new Error('invalid replay sequence');
    if (!Number.isSafeInteger(limit) || limit <= 0)
      throw new Error('replay limit must be positive');
    const current = this.scope(scope.executionId);
    if (!current || current.thread_id !== scope.threadId) {
      return {
        events: [],
        earliestAvailableSequence: 1n,
        latestSequence: 0n,
        historyAvailable: true,
      };
    }
    const earliest = Math.max(current.acknowledged_sequence, current.trimmed_through_sequence) + 1;
    const rows = this.database
      .query<EventRow, [string, string, number, number]>(
        `SELECT thread_id, execution_id, sequence, event_type, data_json, durability, occurred_at
         FROM grpc_event_replay
         WHERE thread_id = ? AND execution_id = ? AND sequence > ?
         ORDER BY sequence ASC LIMIT ?`,
      )
      .all(scope.threadId, scope.executionId, after, limit);
    return {
      events: rows.map(serialize),
      earliestAvailableSequence: BigInt(earliest),
      latestSequence: BigInt(current.next_sequence - 1),
      historyAvailable: after >= current.trimmed_through_sequence,
    };
  }

  resumeCursors(): Array<{ executionId: string; lastAcceptedSequence: bigint }> {
    return this.database
      .query<Pick<ScopeRow, 'execution_id' | 'acknowledged_sequence'>, []>(
        `SELECT execution_id, acknowledged_sequence FROM grpc_event_scopes
         ORDER BY execution_id ASC`,
      )
      .all()
      .map((row) => ({
        executionId: row.execution_id,
        lastAcceptedSequence: BigInt(row.acknowledged_sequence),
      }));
  }

  /**
   * Returns scopes ready for replay, prioritizing executions whose terminal
   * state is waiting while preserving sequence order inside each scope.
   */
  pendingScopes(limit = 100): GrpcPendingEventScope[] {
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new Error('pending event scope limit must be positive');
    }
    return this.database
      .query<
        {
          thread_id: string;
          execution_id: string;
          has_terminal_event: number;
          earliest_sequence: number;
        },
        [number, number]
      >(
        `SELECT thread_id,
                execution_id,
                MAX(CASE WHEN durability = ? THEN 1 ELSE 0 END) AS has_terminal_event,
                MIN(sequence) AS earliest_sequence
         FROM grpc_event_replay
         GROUP BY thread_id, execution_id
         ORDER BY has_terminal_event DESC, earliest_sequence ASC, execution_id ASC
         LIMIT ?`,
      )
      .all(EventDurability.TERMINAL, limit)
      .map((row) => ({
        threadId: row.thread_id,
        executionId: row.execution_id,
        hasTerminalEvent: row.has_terminal_event === 1,
        earliestSequence: BigInt(row.earliest_sequence),
      }));
  }

  close(): void {
    this.database.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    this.database.close();
  }

  private scope(executionId: string): ScopeRow | null {
    return this.database
      .query<ScopeRow, [string]>('SELECT * FROM grpc_event_scopes WHERE execution_id = ?')
      .get(executionId);
  }

  private prune(scope: GrpcEventScope): void {
    const totals = this.database
      .query<
        {
          event_count: number;
          byte_count: number;
          terminal_count: number;
          terminal_bytes: number;
        },
        [number, number, string, string]
      >(
        `SELECT COUNT(*) AS event_count,
                COALESCE(SUM(byte_size), 0) AS byte_count,
                COALESCE(SUM(CASE WHEN durability = ? THEN 1 ELSE 0 END), 0) AS terminal_count,
                COALESCE(SUM(CASE WHEN durability = ? THEN byte_size ELSE 0 END), 0) AS terminal_bytes
         FROM grpc_event_replay WHERE thread_id = ? AND execution_id = ?`,
      )
      .get(EventDurability.TERMINAL, EventDurability.TERMINAL, scope.threadId, scope.executionId)!;
    let eventCount = totals.event_count;
    let byteCount = totals.byte_count;
    const countLimit =
      this.maxEventsPerScope + Math.min(totals.terminal_count, this.terminalReserveEvents);
    const byteLimit =
      this.maxBytesPerScope + Math.min(totals.terminal_bytes, this.terminalReserveBytes);
    let trimmedThrough = 0;
    while (eventCount > countLimit || byteCount > byteLimit) {
      const oldest = this.database
        .query<{ sequence: number; byte_size: number }, [string, string]>(
          `SELECT sequence, byte_size FROM grpc_event_replay
           WHERE thread_id = ? AND execution_id = ? ORDER BY sequence ASC LIMIT 1`,
        )
        .get(scope.threadId, scope.executionId);
      if (!oldest) break;
      this.database
        .query(
          `DELETE FROM grpc_event_replay
           WHERE thread_id = ? AND execution_id = ? AND sequence = ?`,
        )
        .run(scope.threadId, scope.executionId, oldest.sequence);
      eventCount -= 1;
      byteCount -= oldest.byte_size;
      trimmedThrough = oldest.sequence;
    }
    if (trimmedThrough > 0) {
      this.database
        .query(
          `UPDATE grpc_event_scopes
           SET trimmed_through_sequence = MAX(trimmed_through_sequence, ?)
           WHERE thread_id = ? AND execution_id = ?`,
        )
        .run(trimmedThrough, scope.threadId, scope.executionId);
    }
  }
}
