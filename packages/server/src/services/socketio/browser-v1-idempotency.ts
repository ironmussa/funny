import { fromBinary, toBinary } from '@bufbuild/protobuf';
import { OperationOutcomeSchema, type OperationOutcome } from '@funny/shared/browser-v1/operations';

import { SqlOperationIdempotencyStore } from '../operation-idempotency.js';

interface IdempotencyEntry<T> {
  fingerprint: string;
  createdAt: number;
  outcome: Promise<T>;
}

export type IdempotencyResult<T> =
  | { kind: 'outcome'; outcome: T; replayed: boolean }
  | { kind: 'conflict' }
  | { kind: 'in-progress' };

export interface BrowserV1IdempotencyPort {
  execute(input: {
    principalUserId: string;
    idempotencyKey: string;
    fingerprint: string;
    operation: () => Promise<OperationOutcome>;
  }): Promise<IdempotencyResult<OperationOutcome>>;
}

export class BrowserV1IdempotencyStore implements BrowserV1IdempotencyPort {
  private readonly entries = new Map<string, IdempotencyEntry<unknown>>();

  constructor(
    private readonly options: {
      retentionMs: number;
      maxEntries: number;
      now?: () => number;
    },
  ) {
    if (options.retentionMs <= 0 || options.maxEntries <= 0) {
      throw new Error('browser operation idempotency budgets must be positive');
    }
  }

  async execute<T>(input: {
    principalUserId: string;
    idempotencyKey: string;
    fingerprint: string;
    operation: () => Promise<T>;
  }): Promise<IdempotencyResult<T>> {
    this.prune();
    const key = `${input.principalUserId}\0${input.idempotencyKey}`;
    const existing = this.entries.get(key) as IdempotencyEntry<T> | undefined;
    if (existing) {
      if (existing.fingerprint !== input.fingerprint) return { kind: 'conflict' };
      return { kind: 'outcome', outcome: await existing.outcome, replayed: true };
    }

    const outcome = input.operation();
    this.entries.set(key, {
      fingerprint: input.fingerprint,
      createdAt: this.now(),
      outcome,
    });
    try {
      return { kind: 'outcome', outcome: await outcome, replayed: false };
    } catch (error) {
      this.entries.delete(key);
      throw error;
    }
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private prune(): void {
    const oldest = this.now() - this.options.retentionMs;
    for (const [key, entry] of this.entries) {
      if (entry.createdAt < oldest) this.entries.delete(key);
    }
    while (this.entries.size >= this.options.maxEntries) {
      const oldestKey = this.entries.keys().next().value as string | undefined;
      if (!oldestKey) break;
      this.entries.delete(oldestKey);
    }
  }
}

export class DurableBrowserV1IdempotencyStore implements BrowserV1IdempotencyPort {
  constructor(
    private readonly store = new SqlOperationIdempotencyStore({ retentionMs: 24 * 60 * 60_000 }),
  ) {}

  async execute(input: {
    principalUserId: string;
    idempotencyKey: string;
    fingerprint: string;
    operation: () => Promise<OperationOutcome>;
  }): Promise<IdempotencyResult<OperationOutcome>> {
    const result = await this.store.execute(
      {
        runnerId: `browser:${input.principalUserId}`,
        operationKind: 'browser.v1.operation',
        idempotencyKey: input.idempotencyKey,
        request: { fingerprint: input.fingerprint },
      },
      async () =>
        Buffer.from(toBinary(OperationOutcomeSchema, await input.operation())).toString('base64'),
    );
    if (result.kind === 'conflict') return { kind: 'conflict' };
    if (result.kind === 'in_progress') return { kind: 'in-progress' };
    return {
      kind: 'outcome',
      outcome: fromBinary(OperationOutcomeSchema, Buffer.from(result.outcome, 'base64')),
      replayed: result.kind === 'replayed',
    };
  }
}

export const browserV1IdempotencyStore = new DurableBrowserV1IdempotencyStore();
