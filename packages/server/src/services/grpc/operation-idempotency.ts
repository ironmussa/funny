import { createHash } from 'node:crypto';

import { parseStoredJson } from '@funny/shared/json-validation';
import { canonicalJson } from '@funny/shared/lib/canonical-json';
import { and, eq, lt } from 'drizzle-orm';
import { z } from 'zod';

import { db, dbAll, dbGet, dbRun, withDatabaseTransaction } from '../../db/index.js';
import { runnerOperationIdempotency } from '../../db/schema.js';

export type IdempotencyExecution<T> =
  | { kind: 'executed'; outcome: T }
  | { kind: 'replayed'; outcome: T }
  | { kind: 'conflict' }
  | { kind: 'in_progress' };

export interface OperationIdempotencyStore {
  execute<T>(
    input: {
      runnerId: string;
      operationKind: string;
      idempotencyKey: string;
      request: unknown;
    },
    execute: () => Promise<T>,
  ): Promise<IdempotencyExecution<T>>;
  cleanupExpired(now?: Date): Promise<number>;
}

interface StoredRecord {
  requestFingerprint: string;
  status: string;
  outcomeJson: string | null;
  expiresAt: string;
}

export interface SqlOperationIdempotencyOptions {
  retentionMs: number;
  now?: () => Date;
  database?: any;
  transaction?: <T>(work: () => Promise<T>) => Promise<T>;
}

function fingerprint(request: unknown): string {
  return createHash('sha256').update(canonicalJson(request)).digest('hex');
}

/** Durable, runner-scoped application idempotency for persistent operations. */
export class SqlOperationIdempotencyStore implements OperationIdempotencyStore {
  private readonly database: any;
  private readonly now: () => Date;
  private readonly transaction: <T>(work: () => Promise<T>) => Promise<T>;
  private readonly inFlight = new Map<
    string,
    { requestFingerprint: string; promise: Promise<IdempotencyExecution<any>> }
  >();
  private lastCleanupAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly options: SqlOperationIdempotencyOptions) {
    if (!Number.isSafeInteger(options.retentionMs) || options.retentionMs <= 0) {
      throw new Error('idempotency retention must be a positive integer');
    }
    this.database = options.database ?? db;
    this.now = options.now ?? (() => new Date());
    this.transaction = options.transaction ?? withDatabaseTransaction;
  }

  async execute<T>(
    input: {
      runnerId: string;
      operationKind: string;
      idempotencyKey: string;
      request: unknown;
    },
    execute: () => Promise<T>,
  ): Promise<IdempotencyExecution<T>> {
    const now = this.now();
    const cleanupIntervalMs = Math.min(this.options.retentionMs, 60 * 60 * 1000);
    if (now.getTime() - this.lastCleanupAt >= cleanupIntervalMs) {
      await this.cleanupExpired(now);
      this.lastCleanupAt = now.getTime();
    }

    const scope = `${input.runnerId}\0${input.operationKind}\0${input.idempotencyKey}`;
    const requestFingerprint = fingerprint(input.request);
    const active = this.inFlight.get(scope);
    if (active) {
      if (active.requestFingerprint !== requestFingerprint) return { kind: 'conflict' };
      return active.promise;
    }

    const promise = this.transaction(async () => this.executeOnce(input, execute));
    this.inFlight.set(scope, { requestFingerprint, promise });
    try {
      return await promise;
    } finally {
      this.inFlight.delete(scope);
    }
  }

  private async executeOnce<T>(
    input: {
      runnerId: string;
      operationKind: string;
      idempotencyKey: string;
      request: unknown;
    },
    execute: () => Promise<T>,
  ): Promise<IdempotencyExecution<T>> {
    const requestFingerprint = fingerprint(input.request);
    const where = and(
      eq(runnerOperationIdempotency.runnerId, input.runnerId),
      eq(runnerOperationIdempotency.operationKind, input.operationKind),
      eq(runnerOperationIdempotency.idempotencyKey, input.idempotencyKey),
    );
    let record = await dbGet<StoredRecord>(
      this.database
        .select({
          requestFingerprint: runnerOperationIdempotency.requestFingerprint,
          status: runnerOperationIdempotency.status,
          outcomeJson: runnerOperationIdempotency.outcomeJson,
          expiresAt: runnerOperationIdempotency.expiresAt,
        })
        .from(runnerOperationIdempotency)
        .where(where),
    );
    if (record && record.expiresAt <= this.now().toISOString()) {
      await dbRun(this.database.delete(runnerOperationIdempotency).where(where));
      record = undefined;
    }
    if (
      record?.requestFingerprint !== undefined &&
      record.requestFingerprint !== requestFingerprint
    ) {
      return { kind: 'conflict' };
    }
    if (record?.status === 'completed' && record.outcomeJson !== null) {
      const outcome = parseStoredJson(
        z.unknown(),
        record.outcomeJson,
        'runner operation idempotency outcome',
      );
      if (!outcome.ok) throw new Error(outcome.error);
      return { kind: 'replayed', outcome: outcome.value as T };
    }
    if (record) return { kind: 'in_progress' };

    const now = this.now();
    const inserted = await dbAll<{ idempotencyKey: string }>(
      this.database
        .insert(runnerOperationIdempotency)
        .values({
          runnerId: input.runnerId,
          operationKind: input.operationKind,
          idempotencyKey: input.idempotencyKey,
          requestFingerprint,
          status: 'in_progress',
          outcomeJson: null,
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + this.options.retentionMs).toISOString(),
        })
        .onConflictDoNothing()
        .returning({ idempotencyKey: runnerOperationIdempotency.idempotencyKey }),
    );
    if (inserted.length === 0) return this.executeOnce(input, execute);

    let outcome: T;
    try {
      outcome = await execute();
    } catch (error) {
      await dbRun(this.database.delete(runnerOperationIdempotency).where(where));
      throw error;
    }

    // Once execution succeeds, never remove the claim if outcome persistence
    // fails. SQLite cannot wrap awaited application work in one transaction;
    // retaining `in_progress` is safer than allowing a committed mutation to
    // execute twice. PostgreSQL rolls the surrounding transaction back.
    const outcomeJson = canonicalJson(outcome);
    if (typeof outcomeJson !== 'string') {
      throw new Error('runner operation idempotency outcome is not JSON serializable');
    }
    await dbRun(
      this.database
        .update(runnerOperationIdempotency)
        .set({
          status: 'completed',
          outcomeJson,
          updatedAt: this.now().toISOString(),
        })
        .where(where),
    );
    return { kind: 'executed', outcome };
  }

  async cleanupExpired(now = this.now()): Promise<number> {
    const removed = await dbAll<{ idempotencyKey: string }>(
      this.database
        .delete(runnerOperationIdempotency)
        .where(lt(runnerOperationIdempotency.expiresAt, now.toISOString()))
        .returning({ idempotencyKey: runnerOperationIdempotency.idempotencyKey }),
    );
    return removed.length;
  }
}
