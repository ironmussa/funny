import { and, eq } from 'drizzle-orm';

import type {
  AppDatabase,
  dbAll as dbAllFn,
  dbGet as dbGetFn,
  dbRun as dbRunFn,
} from '../db/connection.js';
import type * as sqliteSchema from '../db/schema.sqlite.js';
import type {
  PendingPermissionRequest,
  PermissionDecision,
  PermissionRequestRecord,
} from '../types.js';

export interface PendingPermissionRepositoryDeps {
  db: AppDatabase;
  schema: typeof sqliteSchema;
  dbAll: typeof dbAllFn;
  dbGet: typeof dbGetFn;
  dbRun: typeof dbRunFn;
}

export interface CreatePendingPermissionRequest extends PendingPermissionRequest {}

function serialize(row: any): PermissionRequestRecord {
  return {
    requestId: row.requestId,
    threadId: row.threadId,
    runId: row.runId,
    transport: row.transport,
    toolCallId: row.toolCallId,
    toolName: row.toolName,
    ...(row.toolInput ? { toolInput: row.toolInput } : {}),
    canAlwaysAllow: !!row.canAlwaysAllow,
    canDeny: !!row.canDeny,
    requestedAt: row.createdAt,
    status: row.status,
    ...(row.resolvedDecision ? { resolvedDecision: row.resolvedDecision } : {}),
    ...(row.resolvedAt ? { resolvedAt: row.resolvedAt } : {}),
    ...(row.expiredAt ? { expiredAt: row.expiredAt } : {}),
  } as PermissionRequestRecord;
}

/** DB-agnostic storage for structured, live provider permission requests. */
export function createPendingPermissionRepository(deps: PendingPermissionRepositoryDeps) {
  const { db, dbAll, dbGet, schema } = deps;

  async function create(input: CreatePendingPermissionRequest): Promise<void> {
    // There may only be one active request for a thread/run. Expire an older
    // request before creating the replacement; this is safe across dialects.
    await db
      .update(schema.pendingPermissionRequests)
      .set({ status: 'expired', expiredAt: new Date().toISOString() })
      .where(
        and(
          eq(schema.pendingPermissionRequests.threadId, input.threadId),
          eq(schema.pendingPermissionRequests.runId, input.runId),
          eq(schema.pendingPermissionRequests.status, 'active'),
        ),
      );
    await db.insert(schema.pendingPermissionRequests).values({
      requestId: input.requestId,
      threadId: input.threadId,
      runId: input.runId,
      transport: input.transport,
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      toolInput: input.toolInput ?? null,
      canAlwaysAllow: input.canAlwaysAllow ? 1 : 0,
      canDeny: input.canDeny ? 1 : 0,
      status: 'active',
      createdAt: input.requestedAt,
    });
  }

  async function getActive(threadId: string): Promise<PendingPermissionRequest | null> {
    const row = await dbGet(
      db
        .select()
        .from(schema.pendingPermissionRequests)
        .where(
          and(
            eq(schema.pendingPermissionRequests.threadId, threadId),
            eq(schema.pendingPermissionRequests.status, 'active'),
          ),
        ),
    );
    if (!row) return null;
    const {
      status: _status,
      resolvedDecision: _resolvedDecision,
      resolvedAt: _resolvedAt,
      expiredAt: _expiredAt,
      ...request
    } = serialize(row);
    return request;
  }

  async function getActiveById(requestId: string): Promise<PendingPermissionRequest | null> {
    const row = await dbGet(
      db
        .select()
        .from(schema.pendingPermissionRequests)
        .where(
          and(
            eq(schema.pendingPermissionRequests.requestId, requestId),
            eq(schema.pendingPermissionRequests.status, 'active'),
          ),
        ),
    );
    if (!row) return null;
    const {
      status: _status,
      resolvedDecision: _resolvedDecision,
      resolvedAt: _resolvedAt,
      expiredAt: _expiredAt,
      ...request
    } = serialize(row);
    return request;
  }

  async function getById(requestId: string): Promise<PermissionRequestRecord | null> {
    const row = await dbGet(
      db
        .select()
        .from(schema.pendingPermissionRequests)
        .where(eq(schema.pendingPermissionRequests.requestId, requestId)),
    );
    return row ? serialize(row) : null;
  }

  async function resolve(requestId: string, decision: PermissionDecision): Promise<boolean> {
    const rows = await dbAll(
      db
        .update(schema.pendingPermissionRequests)
        .set({
          status: 'resolved',
          resolvedDecision: decision,
          resolvedAt: new Date().toISOString(),
        })
        .where(
          and(
            eq(schema.pendingPermissionRequests.requestId, requestId),
            eq(schema.pendingPermissionRequests.status, 'active'),
          ),
        )
        .returning({ requestId: schema.pendingPermissionRequests.requestId }),
    );
    return rows.length === 1;
  }

  async function expire(requestId: string): Promise<boolean> {
    const rows = await dbAll(
      db
        .update(schema.pendingPermissionRequests)
        .set({ status: 'expired', expiredAt: new Date().toISOString() })
        .where(
          and(
            eq(schema.pendingPermissionRequests.requestId, requestId),
            eq(schema.pendingPermissionRequests.status, 'active'),
          ),
        )
        .returning({ requestId: schema.pendingPermissionRequests.requestId }),
    );
    return rows.length === 1;
  }

  async function expireForRun(threadId: string, runId: string): Promise<void> {
    await db
      .update(schema.pendingPermissionRequests)
      .set({ status: 'expired', expiredAt: new Date().toISOString() })
      .where(
        and(
          eq(schema.pendingPermissionRequests.threadId, threadId),
          eq(schema.pendingPermissionRequests.runId, runId),
          eq(schema.pendingPermissionRequests.status, 'active'),
        ),
      );
  }

  /**
   * A runner owns the in-memory continuation for every request on its threads.
   * Once that runner is offline, none of those continuations can be resumed.
   * Return the affected owner/thread pairs so the caller can update live UI.
   */
  async function expireForRunner(
    runnerId: string,
  ): Promise<Array<{ requestId: string; threadId: string; userId: string }>> {
    const active = await dbAll<{ requestId: string; threadId: string; userId: string }>(
      db
        .select({
          requestId: schema.pendingPermissionRequests.requestId,
          threadId: schema.pendingPermissionRequests.threadId,
          userId: schema.threads.userId,
        })
        .from(schema.pendingPermissionRequests)
        .innerJoin(schema.threads, eq(schema.threads.id, schema.pendingPermissionRequests.threadId))
        .where(
          and(
            eq(schema.pendingPermissionRequests.status, 'active'),
            eq(schema.threads.runnerId, runnerId),
          ),
        ),
    );

    const expired: Array<{ requestId: string; threadId: string; userId: string }> = [];
    for (const request of active) {
      if (await expire(request.requestId)) expired.push(request);
    }
    return expired;
  }

  return {
    create,
    getActive,
    getActiveById,
    getById,
    resolve,
    expire,
    expireForRun,
    expireForRunner,
  };
}
