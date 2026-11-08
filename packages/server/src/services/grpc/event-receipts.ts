import { and, eq } from 'drizzle-orm';

import { db, dbGet, dbRun, withDatabaseTransaction } from '../../db/index.js';
import { runnerEventReceipts } from '../../db/schema.js';

export interface EventScopeIdentity {
  threadId: string;
  executionId: string;
}

export type EventAcceptance =
  | { kind: 'accepted'; highestContiguousSequence: bigint }
  | { kind: 'duplicate'; highestContiguousSequence: bigint }
  | { kind: 'out_of_order'; highestContiguousSequence: bigint };

export interface AcceptInput {
  runnerId: string;
  scope: EventScopeIdentity;
  sequence: bigint;
  /**
   * Whether `apply` writes to the database. Defaults to true. A non-durable
   * event (a transient chunk) whose `apply` writes nothing can advance its
   * receipt with one atomic statement instead of a transaction.
   */
  durable?: boolean;
}

export interface EventReceiptStore {
  highestAccepted(runnerId: string, executionId: string): Promise<bigint>;
  accept(input: AcceptInput, apply: () => Promise<void>): Promise<EventAcceptance>;
  resynchronize(
    input: {
      runnerId: string;
      scope: EventScopeIdentity;
      missingThroughSequence: bigint;
    },
    apply: () => Promise<void>,
  ): Promise<bigint>;
}

interface ReceiptRow {
  threadId: string;
  highestContiguousSequence: string;
}

/** Upper bound on executions whose last receipt is kept in memory. */
const RECEIPT_CACHE_LIMIT = 10_000;

/**
 * Durable cumulative receipts for each runner event execution.
 *
 * Every accepted event still persists its receipt before it is acknowledged:
 * the runner trusts its own acknowledged cursor on reconnect and does not
 * rewind to the server's, so a receipt that lived only in memory and was lost
 * in a crash would stall the execution (every later event out of order).
 *
 * What is cached is the last persisted receipt per execution. It lets a
 * transient event skip the read-and-write transaction (BEGIN, SELECT, UPSERT,
 * COMMIT: four round trips on PostgreSQL) for one atomic UPSERT. The cache is
 * only correct with a single store instance per server, which
 * `createRunnerGrpcServer` provides, and the single-server deployment the
 * server assumes.
 */
export class SqlEventReceiptStore implements EventReceiptStore {
  private readonly database: any;
  private readonly transaction: <T>(work: () => Promise<T>) => Promise<T>;
  private readonly now: () => Date;
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private readonly receipts = new Map<string, { threadId: string; highest: bigint }>();

  constructor(
    options: {
      database?: any;
      transaction?: <T>(work: () => Promise<T>) => Promise<T>;
      now?: () => Date;
    } = {},
  ) {
    this.database = options.database ?? db;
    this.transaction = options.transaction ?? withDatabaseTransaction;
    this.now = options.now ?? (() => new Date());
  }

  async highestAccepted(runnerId: string, executionId: string): Promise<bigint> {
    const record = await dbGet<Pick<ReceiptRow, 'highestContiguousSequence'>>(
      this.database
        .select({
          highestContiguousSequence: runnerEventReceipts.highestContiguousSequence,
        })
        .from(runnerEventReceipts)
        .where(
          and(
            eq(runnerEventReceipts.runnerId, runnerId),
            eq(runnerEventReceipts.executionId, executionId),
          ),
        ),
    );
    return record ? BigInt(record.highestContiguousSequence) : 0n;
  }

  async accept(input: AcceptInput, apply: () => Promise<void>): Promise<EventAcceptance> {
    const key = `${input.runnerId}\0${input.scope.executionId}`;
    return this.serialize(key, async () => {
      const cached = this.receipts.get(key);
      if (input.durable === false && cached && cached.threadId === input.scope.threadId) {
        return this.acceptTransient(key, input, cached.highest, apply);
      }
      const result = await this.transaction(() => this.acceptOnce(input, apply));
      // `accepted` and `duplicate` mean the execution belongs to this thread
      // (another thread's execution is reported as out_of_order).
      if (result.kind !== 'out_of_order') {
        this.remember(key, input.scope.threadId, result.highestContiguousSequence);
      }
      return result;
    });
  }

  /** Cache hit for an event whose `apply` writes nothing: no transaction needed. */
  private async acceptTransient(
    key: string,
    input: AcceptInput,
    highest: bigint,
    apply: () => Promise<void>,
  ): Promise<EventAcceptance> {
    if (input.sequence <= highest) return { kind: 'duplicate', highestContiguousSequence: highest };
    if (input.sequence !== highest + 1n) {
      return { kind: 'out_of_order', highestContiguousSequence: highest };
    }
    await apply();
    await this.persist(input.runnerId, input.scope, input.sequence);
    this.remember(key, input.scope.threadId, input.sequence);
    return { kind: 'accepted', highestContiguousSequence: input.sequence };
  }

  private remember(key: string, threadId: string, highest: bigint): void {
    this.receipts.delete(key);
    this.receipts.set(key, { threadId, highest });
    if (this.receipts.size > RECEIPT_CACHE_LIMIT) {
      const oldest = this.receipts.keys().next().value;
      if (oldest !== undefined) this.receipts.delete(oldest);
    }
  }

  private persist(runnerId: string, scope: EventScopeIdentity, sequence: bigint): Promise<unknown> {
    const updatedAt = this.now().toISOString();
    return dbRun(
      this.database
        .insert(runnerEventReceipts)
        .values({
          runnerId,
          threadId: scope.threadId,
          executionId: scope.executionId,
          highestContiguousSequence: sequence.toString(),
          updatedAt,
        })
        .onConflictDoUpdate({
          target: [runnerEventReceipts.runnerId, runnerEventReceipts.executionId],
          set: { highestContiguousSequence: sequence.toString(), updatedAt },
        }),
    );
  }

  async resynchronize(
    input: {
      runnerId: string;
      scope: EventScopeIdentity;
      missingThroughSequence: bigint;
    },
    apply: () => Promise<void>,
  ): Promise<bigint> {
    const key = `${input.runnerId}\0${input.scope.executionId}`;
    return this.serialize(key, async () => {
      const highest = await this.transaction(() => this.resynchronizeOnce(input, apply));
      this.remember(key, input.scope.threadId, highest);
      return highest;
    });
  }

  private async serialize<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.inFlight.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(work);
    this.inFlight.set(key, current);
    try {
      return await current;
    } finally {
      if (this.inFlight.get(key) === current) this.inFlight.delete(key);
    }
  }

  private async resynchronizeOnce(
    input: {
      runnerId: string;
      scope: EventScopeIdentity;
      missingThroughSequence: bigint;
    },
    apply: () => Promise<void>,
  ): Promise<bigint> {
    const where = and(
      eq(runnerEventReceipts.runnerId, input.runnerId),
      eq(runnerEventReceipts.executionId, input.scope.executionId),
    );
    const record = await dbGet<ReceiptRow>(
      this.database
        .select({
          threadId: runnerEventReceipts.threadId,
          highestContiguousSequence: runnerEventReceipts.highestContiguousSequence,
        })
        .from(runnerEventReceipts)
        .where(where),
    );
    if (record && record.threadId !== input.scope.threadId) {
      throw new Error('event execution is already assigned to another thread');
    }
    const highest = record ? BigInt(record.highestContiguousSequence) : 0n;
    if (input.missingThroughSequence <= highest) return highest;

    await apply();
    await this.persist(input.runnerId, input.scope, input.missingThroughSequence);
    return input.missingThroughSequence;
  }

  private async acceptOnce(
    input: AcceptInput,
    apply: () => Promise<void>,
  ): Promise<EventAcceptance> {
    const where = and(
      eq(runnerEventReceipts.runnerId, input.runnerId),
      eq(runnerEventReceipts.executionId, input.scope.executionId),
    );
    const record = await dbGet<ReceiptRow>(
      this.database
        .select({
          threadId: runnerEventReceipts.threadId,
          highestContiguousSequence: runnerEventReceipts.highestContiguousSequence,
        })
        .from(runnerEventReceipts)
        .where(where),
    );
    if (record && record.threadId !== input.scope.threadId) {
      return {
        kind: 'out_of_order',
        highestContiguousSequence: BigInt(record.highestContiguousSequence),
      };
    }
    const highest = record ? BigInt(record.highestContiguousSequence) : 0n;
    if (input.sequence <= highest) {
      return { kind: 'duplicate', highestContiguousSequence: highest };
    }
    if (input.sequence !== highest + 1n) {
      return { kind: 'out_of_order', highestContiguousSequence: highest };
    }

    await apply();
    await this.persist(input.runnerId, input.scope, input.sequence);
    return { kind: 'accepted', highestContiguousSequence: input.sequence };
  }
}
