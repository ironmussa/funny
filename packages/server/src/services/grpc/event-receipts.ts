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

export interface EventReceiptStore {
  highestAccepted(runnerId: string, executionId: string): Promise<bigint>;
  accept(
    input: { runnerId: string; scope: EventScopeIdentity; sequence: bigint },
    apply: () => Promise<void>,
  ): Promise<EventAcceptance>;
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

/** Durable cumulative receipts for each runner event execution. */
export class SqlEventReceiptStore implements EventReceiptStore {
  private readonly database: any;
  private readonly transaction: <T>(work: () => Promise<T>) => Promise<T>;
  private readonly now: () => Date;
  private readonly inFlight = new Map<string, Promise<unknown>>();

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

  async accept(
    input: { runnerId: string; scope: EventScopeIdentity; sequence: bigint },
    apply: () => Promise<void>,
  ): Promise<EventAcceptance> {
    const key = `${input.runnerId}\0${input.scope.executionId}`;
    return this.serialize(key, () => this.transaction(() => this.acceptOnce(input, apply)));
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
    return this.serialize(key, () => this.transaction(() => this.resynchronizeOnce(input, apply)));
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
    await dbRun(
      this.database
        .insert(runnerEventReceipts)
        .values({
          runnerId: input.runnerId,
          threadId: input.scope.threadId,
          executionId: input.scope.executionId,
          highestContiguousSequence: input.missingThroughSequence.toString(),
          updatedAt: this.now().toISOString(),
        })
        .onConflictDoUpdate({
          target: [runnerEventReceipts.runnerId, runnerEventReceipts.executionId],
          set: {
            highestContiguousSequence: input.missingThroughSequence.toString(),
            updatedAt: this.now().toISOString(),
          },
        }),
    );
    return input.missingThroughSequence;
  }

  private async acceptOnce(
    input: { runnerId: string; scope: EventScopeIdentity; sequence: bigint },
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
    await dbRun(
      this.database
        .insert(runnerEventReceipts)
        .values({
          runnerId: input.runnerId,
          threadId: input.scope.threadId,
          executionId: input.scope.executionId,
          highestContiguousSequence: input.sequence.toString(),
          updatedAt: this.now().toISOString(),
        })
        .onConflictDoUpdate({
          target: [runnerEventReceipts.runnerId, runnerEventReceipts.executionId],
          set: {
            highestContiguousSequence: input.sequence.toString(),
            updatedAt: this.now().toISOString(),
          },
        }),
    );
    return { kind: 'accepted', highestContiguousSequence: input.sequence };
  }
}
