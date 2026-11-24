import { Database } from 'bun:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { parseStoredJson } from '@funny/shared/json-validation';
import { canonicalJson } from '@funny/shared/lib/canonical-json';
import { z } from 'zod';

import { DATA_DIR } from '../lib/data-dir.js';

export interface GrpcOutboxOperation {
  idempotencyKey: string;
  operationKind: string;
  payload: unknown;
  createdAt: string;
  attemptCount: number;
  lastAttemptAt: string | null;
}

interface OutboxRow {
  idempotency_key: string;
  operation_kind: string;
  payload_json: string;
  created_at: string;
  attempt_count: number;
  last_attempt_at: string | null;
}

function assertDurableJson(
  value: unknown,
  path = 'payload',
  ancestors = new WeakSet<object>(),
): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return;
  }
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return;
    throw new Error(`${path} must contain only finite JSON numbers`);
  }
  if (typeof value !== 'object') {
    throw new Error(`${path} must contain only durable JSON values`);
  }
  if (ancestors.has(value)) throw new Error(`${path} must not contain circular references`);

  ancestors.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!(index in value)) throw new Error(`${path}[${index}] must not be a sparse array entry`);
      assertDurableJson(value[index], `${path}[${index}]`, ancestors);
    }
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`${path} must contain only plain JSON objects`);
    }
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') {
        if (Object.prototype.propertyIsEnumerable.call(value, key)) {
          throw new Error(`${path} must not contain symbol keys`);
        }
        continue;
      }
      if (Object.prototype.propertyIsEnumerable.call(value, key)) {
        // SAFETY: `value` is a non-null, non-array plain object (checked above) and `key` is one of its
        // own enumerable string keys, so indexing it as a string record reads that property.
        assertDurableJson((value as Record<string, unknown>)[key], `${path}.${key}`, ancestors);
      }
    }
  }
  ancestors.delete(value);
}

/** A replay older than this is stale: the thread it wrote to has moved on. */
export const OUTBOX_ENTRY_TTL_MS = 24 * 60 * 60 * 1000;
/** Deliveries that never got an application outcome; past this the row is dropped. */
export const OUTBOX_MAX_ATTEMPTS = 20;
const REPLAY_PAGE_SIZE = 100;

export type OutboxDropReason = 'corrupt' | 'expired' | 'attempts-exhausted';

export interface OutboxReplayOptions {
  now?: number;
  ttlMs?: number;
  maxAttempts?: number;
  pageSize?: number;
  /** Told about every row removed instead of replayed. */
  onDropped?: (idempotencyKey: string, reason: OutboxDropReason, detail?: string) => void;
}

interface OutboxDrop {
  reason: OutboxDropReason;
  detail?: string;
}

/** Why a row must not be replayed any more, if it must not. */
function rejectReplay(row: OutboxRow, options: OutboxReplayOptions): OutboxDrop | null {
  const createdAt = Date.parse(row.created_at);
  if (!Number.isFinite(createdAt)) return { reason: 'corrupt', detail: 'unreadable created_at' };
  const age = (options.now ?? Date.now()) - createdAt;
  if (age > (options.ttlMs ?? OUTBOX_ENTRY_TTL_MS)) return { reason: 'expired' };
  if (row.attempt_count >= (options.maxAttempts ?? OUTBOX_MAX_ATTEMPTS)) {
    return { reason: 'attempts-exhausted' };
  }
  return null;
}

function readRow(row: OutboxRow): { operation: GrpcOutboxOperation } | OutboxDrop {
  try {
    return { operation: serialize(row) };
  } catch (error) {
    return { reason: 'corrupt', detail: error instanceof Error ? error.message : String(error) };
  }
}

function serialize(row: OutboxRow): GrpcOutboxOperation {
  const payload = parseStoredJson(z.unknown(), row.payload_json, 'gRPC outbox payload');
  if (!payload.ok) throw new Error(payload.error);
  return {
    idempotencyKey: row.idempotency_key,
    operationKind: row.operation_kind,
    payload: payload.value,
    createdAt: row.created_at,
    attemptCount: row.attempt_count,
    lastAttemptAt: row.last_attempt_at,
  };
}

/**
 * Small runner-local SQLite outbox. It remains available in TEAM_SERVER_URL
 * mode, where the application database is intentionally disabled, and owns
 * only retryable gRPC mutations awaiting an application-level outcome.
 */
export class GrpcOperationOutbox {
  private readonly database: Database;

  constructor(path = resolve(DATA_DIR, 'runner-grpc-outbox.db')) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.database = new Database(path, { create: true, strict: true });
    this.database.exec('PRAGMA journal_mode = WAL');
    this.database.exec('PRAGMA synchronous = FULL');
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS grpc_operation_outbox (
        idempotency_key TEXT PRIMARY KEY,
        operation_kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        last_attempt_at TEXT
      )
    `);
    if (path !== ':memory:') chmodSync(path, 0o600);
  }

  enqueue(input: {
    idempotencyKey: string;
    operationKind: string;
    payload: unknown;
    createdAt?: string;
  }): GrpcOutboxOperation {
    if (!input.idempotencyKey || !input.operationKind) {
      throw new Error('outbox operations require an idempotency key and operation kind');
    }
    assertDurableJson(input.payload);
    const payloadJson = canonicalJson(input.payload);
    this.database
      .query(
        `INSERT OR IGNORE INTO grpc_operation_outbox
          (idempotency_key, operation_kind, payload_json, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(
        input.idempotencyKey,
        input.operationKind,
        payloadJson,
        input.createdAt ?? new Date().toISOString(),
      );
    const queued = this.database
      .query<OutboxRow, [string]>('SELECT * FROM grpc_operation_outbox WHERE idempotency_key = ?')
      .get(input.idempotencyKey);
    if (!queued) throw new Error('failed to persist outbox operation');
    if (queued.operation_kind !== input.operationKind || queued.payload_json !== payloadJson) {
      throw new Error('idempotency key is already queued for a different mutation');
    }
    return serialize(queued);
  }

  pending(limit = 100): GrpcOutboxOperation[] {
    if (!Number.isSafeInteger(limit) || limit <= 0)
      throw new Error('outbox limit must be positive');
    return this.database
      .query<OutboxRow, [number]>(
        `SELECT * FROM grpc_operation_outbox
         ORDER BY created_at ASC, idempotency_key ASC LIMIT ?`,
      )
      .all(limit)
      .map(serialize);
  }

  /**
   * Every row still worth replaying, oldest first, read page by page so a large
   * backlog is replayed whole. Rows past the TTL or the attempt cap, and rows
   * that cannot be read back, are deleted and reported instead of replayed; a
   * bad row never stops the rows after it.
   */
  *replayable(options: OutboxReplayOptions = {}): Generator<GrpcOutboxOperation> {
    const pageSize = options.pageSize ?? REPLAY_PAGE_SIZE;
    if (!Number.isSafeInteger(pageSize) || pageSize <= 0) {
      throw new Error('outbox page size must be positive');
    }
    let after: OutboxRow | undefined;
    for (;;) {
      const page = this.pageAfter(after, pageSize);
      for (const row of page) {
        const operation = this.replayableRow(row, options);
        if (operation) yield operation;
      }
      if (page.length < pageSize) return;
      after = page[page.length - 1];
    }
  }

  /** Keyset page in replay order, so rows deleted mid-replay never shift it. */
  private pageAfter(after: OutboxRow | undefined, limit: number): OutboxRow[] {
    if (!after) {
      return this.database
        .query<OutboxRow, [number]>(
          `SELECT * FROM grpc_operation_outbox
           ORDER BY created_at ASC, idempotency_key ASC LIMIT ?`,
        )
        .all(limit);
    }
    return this.database
      .query<OutboxRow, [string, string, string, number]>(
        `SELECT * FROM grpc_operation_outbox
         WHERE created_at > ? OR (created_at = ? AND idempotency_key > ?)
         ORDER BY created_at ASC, idempotency_key ASC LIMIT ?`,
      )
      .all(after.created_at, after.created_at, after.idempotency_key, limit);
  }

  /** The row as an operation, or `null` after deleting and reporting it. */
  private replayableRow(row: OutboxRow, options: OutboxReplayOptions): GrpcOutboxOperation | null {
    const checked = rejectReplay(row, options) ?? readRow(row);
    if ('operation' in checked) return checked.operation;
    this.confirm(row.idempotency_key);
    options.onDropped?.(row.idempotency_key, checked.reason, checked.detail);
    return null;
  }

  markAttempt(idempotencyKey: string, attemptedAt = new Date().toISOString()): boolean {
    const result = this.database
      .query(
        `UPDATE grpc_operation_outbox
         SET attempt_count = attempt_count + 1, last_attempt_at = ?
         WHERE idempotency_key = ?`,
      )
      .run(attemptedAt, idempotencyKey);
    return result.changes === 1;
  }

  confirm(idempotencyKey: string): boolean {
    return (
      this.database
        .query('DELETE FROM grpc_operation_outbox WHERE idempotency_key = ?')
        .run(idempotencyKey).changes === 1
    );
  }

  /** Drops a mutation whose caller gave up, so it is never replayed. */
  discard(idempotencyKey: string): boolean {
    return this.confirm(idempotencyKey);
  }

  get(idempotencyKey: string): GrpcOutboxOperation | null {
    const row = this.database
      .query<OutboxRow, [string]>('SELECT * FROM grpc_operation_outbox WHERE idempotency_key = ?')
      .get(idempotencyKey);
    return row ? serialize(row) : null;
  }

  close(): void {
    this.database.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    this.database.close();
  }
}
