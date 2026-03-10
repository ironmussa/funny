/**
 * @domain subdomain: User Profile
 * @domain subdomain-type: generic
 * @domain type: repository
 * @domain layer: infrastructure
 * @domain depends: Database, Crypto
 */

import type { UserProfile, UpdateProfileRequest } from '@funny/shared';
import { eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';

import { db, dbGet, dbRun } from '../db/index.js';
import * as schema from '../db/schema.js';
import { encrypt, decrypt } from '../lib/crypto.js';

/** Retrieve a user's git profile. Returns null if not yet configured. */
export async function getProfile(userId: string): Promise<UserProfile | null> {
  const row = await dbGet(
    db.select().from(schema.userProfiles).where(eq(schema.userProfiles.userId, userId)),
  );
  if (!row) return null;
  return {
    id: row.id,
    userId: row.userId,
    gitName: row.gitName,
    gitEmail: row.gitEmail,
    hasGithubToken: !!row.githubToken,
    setupCompleted: !!row.setupCompleted,
    defaultEditor: row.defaultEditor ?? null,
    useInternalEditor: row.useInternalEditor != null ? !!row.useInternalEditor : null,
    terminalShell: row.terminalShell ?? null,
    toolPermissions: row.toolPermissions ? JSON.parse(row.toolPermissions) : null,
    theme: row.theme ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Retrieve the raw GitHub token (server-only, never return to client). */
export async function getGithubToken(userId: string): Promise<string | null> {
  const row = await dbGet(
    db
      .select({ githubToken: schema.userProfiles.githubToken })
      .from(schema.userProfiles)
      .where(eq(schema.userProfiles.userId, userId)),
  );
  if (!row?.githubToken) return null;
  return decrypt(row.githubToken);
}

/** Retrieve git author info for --author flag. Returns null if either field is missing. */
export async function getGitIdentity(
  userId: string,
): Promise<{ name: string; email: string } | null> {
  const row = await dbGet(
    db
      .select({
        gitName: schema.userProfiles.gitName,
        gitEmail: schema.userProfiles.gitEmail,
      })
      .from(schema.userProfiles)
      .where(eq(schema.userProfiles.userId, userId)),
  );
  if (!row?.gitName || !row?.gitEmail) return null;
  return { name: row.gitName, email: row.gitEmail };
}

/** Check if user has completed setup. */
export async function isSetupCompleted(userId: string): Promise<boolean> {
  const row = await dbGet(
    db
      .select({ setupCompleted: schema.userProfiles.setupCompleted })
      .from(schema.userProfiles)
      .where(eq(schema.userProfiles.userId, userId)),
  );
  return !!row?.setupCompleted;
}

/** Upsert the user's profile. */
export async function updateProfile(
  userId: string,
  data: UpdateProfileRequest,
): Promise<UserProfile> {
  const now = new Date().toISOString();
  const existing = await dbGet(
    db.select().from(schema.userProfiles).where(eq(schema.userProfiles.userId, userId)),
  );

  const encryptedToken = data.githubToken ? encrypt(data.githubToken) : null;

  if (existing) {
    const updates: Record<string, any> = { updatedAt: now };
    if (data.gitName !== undefined) updates.gitName = data.gitName || null;
    if (data.gitEmail !== undefined) updates.gitEmail = data.gitEmail || null;
    if (data.githubToken !== undefined) updates.githubToken = encryptedToken;
    if (data.setupCompleted !== undefined) updates.setupCompleted = data.setupCompleted ? 1 : 0;
    if (data.defaultEditor !== undefined) updates.defaultEditor = data.defaultEditor;
    if (data.useInternalEditor !== undefined)
      updates.useInternalEditor = data.useInternalEditor ? 1 : 0;
    if (data.terminalShell !== undefined) updates.terminalShell = data.terminalShell;
    if (data.toolPermissions !== undefined)
      updates.toolPermissions = JSON.stringify(data.toolPermissions);
    if (data.theme !== undefined) updates.theme = data.theme;
    await dbRun(
      db.update(schema.userProfiles).set(updates).where(eq(schema.userProfiles.userId, userId)),
    );
  } else {
    await dbRun(
      db.insert(schema.userProfiles).values({
        id: nanoid(),
        userId,
        gitName: data.gitName || null,
        gitEmail: data.gitEmail || null,
        githubToken: encryptedToken,
        setupCompleted: data.setupCompleted ? 1 : 0,
        defaultEditor: data.defaultEditor ?? null,
        useInternalEditor: data.useInternalEditor != null ? (data.useInternalEditor ? 1 : 0) : null,
        terminalShell: data.terminalShell ?? null,
        toolPermissions: data.toolPermissions ? JSON.stringify(data.toolPermissions) : null,
        theme: data.theme ?? null,
        createdAt: now,
        updatedAt: now,
      }),
    );
  }

  return (await getProfile(userId))!;
}
