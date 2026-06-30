/**
 * Regression tests for epoch-millisecond columns on Postgres.
 *
 * Postgres `integer` is int4 (max ~2.1e9). Columns holding millisecond
 * timestamps (~1.7e12) overflow it, so every insert/compare failed with
 * `value "…" is out of range for type integer` — which broke the watcher
 * scanner (`watchers.next_wake_at`) and the scheduler run state
 * (`scheduler_runs.*_at_ms`). These columns must be bigint on Postgres.
 * SQLite's INTEGER is already 8 bytes, so its schema keeps integer.
 */
import { describe, expect, test } from 'bun:test';

import { getTableColumns } from 'drizzle-orm';

import { schedulerRuns as pgSchedulerRuns, watchers as pgWatchers } from '../db/schema.pg.js';
import {
  schedulerRuns as sqliteSchedulerRuns,
  watchers as sqliteWatchers,
} from '../db/schema.sqlite.js';

describe('epoch-ms columns are bigint on Postgres', () => {
  test('watchers.next_wake_at and deadline are bigint', () => {
    const cols = getTableColumns(pgWatchers);
    expect(cols.nextWakeAt.getSQLType()).toBe('bigint');
    expect(cols.deadline.getSQLType()).toBe('bigint');
  });

  test('scheduler_runs *_at_ms columns are bigint', () => {
    const cols = getTableColumns(pgSchedulerRuns);
    expect(cols.nextRetryAtMs.getSQLType()).toBe('bigint');
    expect(cols.lastEventAtMs.getSQLType()).toBe('bigint');
    expect(cols.claimedAtMs.getSQLType()).toBe('bigint');
    expect(cols.updatedAtMs.getSQLType()).toBe('bigint');
  });

  test('small counter columns stay integer (no needless widening)', () => {
    const w = getTableColumns(pgWatchers);
    expect(w.wakeCount.getSQLType()).toBe('integer');
    expect(w.maxWakes.getSQLType()).toBe('integer');
    expect(w.lastDelayMs.getSQLType()).toBe('integer');
  });

  test('SQLite keeps these columns as integer (8-byte, no overflow)', () => {
    const w = getTableColumns(sqliteWatchers);
    expect(w.nextWakeAt.getSQLType()).toBe('integer');
    expect(w.deadline.getSQLType()).toBe('integer');
    const o = getTableColumns(sqliteSchedulerRuns);
    expect(o.lastEventAtMs.getSQLType()).toBe('integer');
    expect(o.claimedAtMs.getSQLType()).toBe('integer');
  });
});
