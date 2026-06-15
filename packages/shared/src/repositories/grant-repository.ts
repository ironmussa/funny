/**
 * @domain subdomain: Authorization
 * @domain subdomain-type: core
 * @domain type: repository
 * @domain layer: infrastructure
 * @domain depends: Database
 *
 * DB-agnostic repository for the unified `resource_grants` table
 * (unified-rbac-grants). One row = one subject's canonical role on one resource
 * (`org` | `project` | `thread`). The composite PK `(subject_id, resource_type,
 * resource_id)` makes a re-grant idempotent — `upsertGrant` updates in place.
 *
 * This repository reads/writes ONLY `resource_grants`. Org membership stays
 * canonical in Better Auth's `member` table (design D1); the server adapts those
 * rows into virtual `org` grants for the authorizer — they are NOT stored here.
 *
 * Pure data access: it knows nothing about inheritance. The thread→project→org
 * chain lives in the authorizer (`auth/authorizer.ts`).
 */

import { and, asc, eq } from 'drizzle-orm';

import type { Role, ResourceType } from '../auth/roles.js';
import { isRole } from '../auth/roles.js';
import type { AppDatabase, dbAll as dbAllFn, dbRun as dbRunFn } from '../db/connection.js';
import type * as sqliteSchema from '../db/schema.sqlite.js';

export interface ResourceGrant {
  subjectId: string;
  resourceType: ResourceType;
  resourceId: string;
  role: Role;
  grantedBy: string;
  createdAt: string;
}

export interface GrantRepositoryDeps {
  db: AppDatabase;
  schema: typeof sqliteSchema;
  dbAll: typeof dbAllFn;
  dbRun: typeof dbRunFn;
}

function normalize(row: any): ResourceGrant {
  return {
    subjectId: row.subjectId ?? row.subject_id,
    resourceType: (row.resourceType ?? row.resource_type) as ResourceType,
    resourceId: row.resourceId ?? row.resource_id,
    role: (row.role as Role) ?? 'viewer',
    grantedBy: row.grantedBy ?? row.granted_by,
    createdAt: row.createdAt ?? row.created_at,
  };
}

export function createGrantRepository(deps: GrantRepositoryDeps) {
  const { db, schema, dbAll, dbRun } = deps;
  const G = schema.resourceGrants;

  /** The full grant for one (subject, resource), or null if none. */
  async function getGrant(
    subjectId: string,
    resourceType: ResourceType,
    resourceId: string,
  ): Promise<ResourceGrant | null> {
    const rows = await dbAll(
      db
        .select()
        .from(G)
        .where(
          and(
            eq(G.subjectId, subjectId),
            eq(G.resourceType, resourceType),
            eq(G.resourceId, resourceId),
          ),
        ),
    );
    return rows.length > 0 ? normalize(rows[0]) : null;
  }

  /** Just the role a subject holds on a resource (explicit grant only). */
  async function getGrantRole(
    subjectId: string,
    resourceType: ResourceType,
    resourceId: string,
  ): Promise<Role | null> {
    const grant = await getGrant(subjectId, resourceType, resourceId);
    return grant?.role ?? null;
  }

  /**
   * Create or update a grant. Idempotent on the composite PK — a repeat grant
   * for the same (subject, resource) updates the role and `grantedBy`, never
   * inserts a duplicate. `role` is validated against the lattice.
   */
  async function upsertGrant(input: {
    subjectId: string;
    resourceType: ResourceType;
    resourceId: string;
    role: Role;
    grantedBy: string;
  }): Promise<ResourceGrant> {
    if (!isRole(input.role)) {
      throw new Error(`Invalid role: ${String(input.role)}`);
    }
    const createdAt = new Date().toISOString();
    await dbRun(
      db
        .insert(G)
        .values({
          subjectId: input.subjectId,
          resourceType: input.resourceType,
          resourceId: input.resourceId,
          role: input.role,
          grantedBy: input.grantedBy,
          createdAt,
        })
        .onConflictDoUpdate({
          target: [G.subjectId, G.resourceType, G.resourceId],
          set: { role: input.role, grantedBy: input.grantedBy },
        }),
    );
    return { ...input, createdAt };
  }

  /** Revoke a grant. No-op if it does not exist. */
  async function deleteGrant(
    subjectId: string,
    resourceType: ResourceType,
    resourceId: string,
  ): Promise<void> {
    await dbRun(
      db
        .delete(G)
        .where(
          and(
            eq(G.subjectId, subjectId),
            eq(G.resourceType, resourceType),
            eq(G.resourceId, resourceId),
          ),
        ),
    );
  }

  /**
   * Purge every grant ON a resource (all subjects). `resource_grants.resource_id`
   * is polymorphic and cannot FK to threads/projects, so it does NOT cascade when
   * the resource row is deleted — callers MUST invoke this from the resource's
   * own deletion path (thread/project delete) to avoid orphaned grants.
   */
  async function deleteGrantsForResource(
    resourceType: ResourceType,
    resourceId: string,
  ): Promise<void> {
    await dbRun(
      db.delete(G).where(and(eq(G.resourceType, resourceType), eq(G.resourceId, resourceId))),
    );
  }

  /** All explicit grants on one resource, oldest first (for "who has access"). */
  async function listGrantsForResource(
    resourceType: ResourceType,
    resourceId: string,
  ): Promise<ResourceGrant[]> {
    const rows = await dbAll(
      db
        .select()
        .from(G)
        .where(and(eq(G.resourceType, resourceType), eq(G.resourceId, resourceId)))
        .orderBy(asc(G.createdAt)),
    );
    return rows.map(normalize);
  }

  /** All resources of a type a subject has an explicit grant on. */
  async function listResourcesForSubject(
    subjectId: string,
    resourceType: ResourceType,
  ): Promise<ResourceGrant[]> {
    const rows = await dbAll(
      db
        .select()
        .from(G)
        .where(and(eq(G.subjectId, subjectId), eq(G.resourceType, resourceType))),
    );
    return rows.map(normalize);
  }

  return {
    getGrant,
    getGrantRole,
    upsertGrant,
    deleteGrant,
    deleteGrantsForResource,
    listGrantsForResource,
    listResourcesForSubject,
  };
}

export type GrantRepository = ReturnType<typeof createGrantRepository>;
