/**
 * @domain subdomain: Workflow Engine
 * @domain subdomain-type: supporting
 * @domain type: repository
 * @domain layer: infrastructure
 *
 * The rows behind the lease gate (`lease-gate.ts`): concurrency-group leases
 * and waiters, including the batch fields of a waiter (the leader that
 * gathered it and the outcome that leader settled). Every function is one
 * statement or a short read; the gate decides the order and serializes a
 * group's grant attempts.
 */
import type { SettledOutcome } from '@funny/pipelines';
import { parseStoredJson } from '@funny/shared/json-validation';
import { and, asc, eq, inArray, isNull, lt, ne, notInArray, or } from 'drizzle-orm';
import { z } from 'zod';

import { db } from '../../db/index.js';
import { workflowConcurrencyLeases, workflowConcurrencyWaiters } from '../../db/schema.js';

const leases = workflowConcurrencyLeases;
const waiters = workflowConcurrencyWaiters;

const leaseOf = (group: string, holder: string) =>
  and(eq(leases.groupKey, group), eq(leases.holder, holder));

const waiterOf = (group: string, holder: string) =>
  and(eq(waiters.groupKey, group), eq(waiters.holder, holder));

const OUTCOME_SCHEMA = z.discriminatedUnion('status', [
  // The whole outcome is already parsed as JSON (`storedJson`), so this accepts the same values.
  z.object({ status: z.literal('succeeded'), output: z.json().optional() }),
  z.object({ status: z.literal('failed'), error: z.string() }),
]);

/** What a waiter needs to know about its own row. */
export interface WaiterRow {
  /** The leader that gathered this waiter into its batch, or null. */
  leader: string | null;
  /** The outcome its leader settled, or null while it waits. */
  outcome: SettledOutcome | null;
}

/** A member of a batch, as its leader gathered it. */
export interface GatheredMember {
  holder: string;
  input: unknown;
}

export interface NewWaiter {
  group: string;
  holder: string;
  limit: number;
  priority: number;
  at: number;
  expiresAt: number;
  batch?: { max: number; waitMs: number };
  input?: unknown;
}

const STORED_JSON_SCHEMA = z.json();

/** A stored JSON column, or undefined when empty; a corrupt value throws. */
function storedJson(
  raw: string | null,
  label: string,
): z.infer<typeof STORED_JSON_SCHEMA> | undefined {
  if (raw === null) return undefined;
  const parsed = parseStoredJson(STORED_JSON_SCHEMA, raw, label);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}

/** Queue a waiter, or refresh the expiry of one already queued (keeping its place). */
export async function enqueueWaiter(w: NewWaiter): Promise<void> {
  await db
    .insert(waiters)
    .values({
      groupKey: w.group,
      holder: w.holder,
      slotLimit: w.limit,
      priority: w.priority,
      requestedAt: w.at,
      expiresAt: w.expiresAt,
      batchMax: w.batch?.max ?? null,
      batchWaitMs: w.batch?.waitMs ?? null,
      input: w.input === undefined ? null : JSON.stringify(w.input),
    })
    .onConflictDoUpdate({
      target: [waiters.groupKey, waiters.holder],
      set: { expiresAt: w.expiresAt, slotLimit: w.limit },
    });
}

export async function readWaiter(group: string, holder: string): Promise<WaiterRow | undefined> {
  const [row] = await db
    .select({ leader: waiters.leader, outcome: waiters.outcome })
    .from(waiters)
    .where(waiterOf(group, holder));
  if (!row) return undefined;
  const outcome =
    row.outcome === null ? null : OUTCOME_SCHEMA.parse(storedJson(row.outcome, 'settled outcome'));
  return { leader: row.leader, outcome };
}

export async function renewWaiter(group: string, holder: string, expiresAt: number) {
  await db.update(waiters).set({ expiresAt }).where(waiterOf(group, holder));
}

export async function removeWaiter(group: string, holder: string) {
  await db.delete(waiters).where(waiterOf(group, holder));
}

/** Drop the group's expired leases and waiters. */
export async function dropExpired(group: string, at: number) {
  await db.delete(leases).where(and(eq(leases.groupKey, group), lt(leases.expiresAt, at)));
  await db.delete(waiters).where(and(eq(waiters.groupKey, group), lt(waiters.expiresAt, at)));
}

/** The holders of the group's leases. */
export async function leaseHolders(group: string): Promise<string[]> {
  const rows = await db
    .select({ holder: leases.holder })
    .from(leases)
    .where(eq(leases.groupKey, group));
  return rows.map((r) => r.holder);
}

/**
 * Members whose leader has no lease any more (its server stopped) and that
 * it did not settle wait again, in the place they had.
 */
export async function freeOrphanedMembers(group: string, liveLeaders: string[]) {
  const orphaned = liveLeaders.length > 0 ? notInArray(waiters.leader, liveLeaders) : undefined;
  await db
    .update(waiters)
    .set({ leader: null })
    .where(and(eq(waiters.groupKey, group), isNull(waiters.outcome), orphaned));
}

/** The first waiter of the group no batch holds, by priority then arrival. */
export async function firstFreeWaiter(group: string): Promise<string | undefined> {
  const [first] = await db
    .select({ holder: waiters.holder })
    .from(waiters)
    .where(and(eq(waiters.groupKey, group), isNull(waiters.leader), isNull(waiters.outcome)))
    .orderBy(asc(waiters.priority), asc(waiters.requestedAt), asc(waiters.holder))
    .limit(1);
  return first?.holder;
}

export async function putLease(group: string, holder: string, at: number, expiresAt: number) {
  await db
    .insert(leases)
    .values({ groupKey: group, holder, expiresAt, acquiredAt: at })
    .onConflictDoUpdate({ target: [leases.groupKey, leases.holder], set: { expiresAt } });
}

export async function renewLease(group: string, holder: string, expiresAt: number) {
  await db.update(leases).set({ expiresAt }).where(leaseOf(group, holder));
}

export async function deleteLease(group: string, holder: string) {
  await db.delete(leases).where(leaseOf(group, holder));
}

/**
 * Gather batch waiters into `leader`'s batch, up to `room` of them: those it
 * already holds (a resumed leader) first, then free ones in queue order.
 * Returns every member the batch now holds.
 */
export async function gatherMembers(
  group: string,
  leader: string,
  room: number,
): Promise<GatheredMember[]> {
  const candidates = await db
    .select({
      holder: waiters.holder,
      leader: waiters.leader,
      input: waiters.input,
      batchMax: waiters.batchMax,
    })
    .from(waiters)
    .where(
      and(
        eq(waiters.groupKey, group),
        ne(waiters.holder, leader),
        isNull(waiters.outcome),
        or(isNull(waiters.leader), eq(waiters.leader, leader)),
      ),
    )
    .orderBy(asc(waiters.priority), asc(waiters.requestedAt), asc(waiters.holder));
  const chosen = candidates
    .filter((c) => c.batchMax !== null)
    .sort((a, b) => Number(a.leader !== leader) - Number(b.leader !== leader))
    .slice(0, Math.max(0, room));
  if (chosen.length > 0) {
    await db
      .update(waiters)
      .set({ leader })
      .where(
        and(
          eq(waiters.groupKey, group),
          inArray(
            waiters.holder,
            chosen.map((c) => c.holder),
          ),
        ),
      );
  }
  return chosen.map((c) => ({
    holder: c.holder,
    input: storedJson(c.input, 'batch member input'),
  }));
}

/**
 * Settle a member once: only while `leader` holds it and nothing was settled.
 * `requeued` puts it back in the queue in its place. False when the member
 * is gone (its run was cancelled) or was settled already.
 */
export async function settleMember(
  group: string,
  leader: string,
  holder: string,
  outcome: SettledOutcome | { status: 'requeued' },
): Promise<boolean> {
  const set =
    outcome.status === 'requeued'
      ? { leader: null, outcome: null }
      : { outcome: JSON.stringify(outcome) };
  const changed = await db
    .update(waiters)
    .set(set)
    .where(and(waiterOf(group, holder), eq(waiters.leader, leader), isNull(waiters.outcome)))
    .returning({ holder: waiters.holder });
  return changed.length > 0;
}

/** The leader is done: members it did not settle wait again. */
export async function releaseMembers(group: string, leader: string) {
  await db
    .update(waiters)
    .set({ leader: null })
    .where(and(eq(waiters.groupKey, group), eq(waiters.leader, leader), isNull(waiters.outcome)));
}
