import { eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { db } from '../db/index.js';
import * as schema from '../db/schema.js';
import { encrypt, decrypt } from '../lib/crypto.js';
import type { UserProfile, UpdateProfileRequest } from '@funny/shared';

/** Retrieve a user's git profile. Returns null if not yet configured. */
export function getProfile(userId: string): UserProfile | null {
  const row = db.select().from(schema.userProfiles)
    .where(eq(schema.userProfiles.userId, userId)).get();
  if (!row) return null;
  return {
    id: row.id,
    userId: row.userId,
    gitName: row.gitName,
    gitEmail: row.gitEmail,
    hasGithubToken: !!row.githubToken,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Retrieve the raw GitHub token (server-only, never return to client). */
export function getGithubToken(userId: string): string | null {
  const row = db.select({ githubToken: schema.userProfiles.githubToken })
    .from(schema.userProfiles)
    .where(eq(schema.userProfiles.userId, userId)).get();
  if (!row?.githubToken) return null;
  return decrypt(row.githubToken);
}

/** Retrieve git author info for --author flag. Returns null if either field is missing. */
export function getGitIdentity(userId: string): { name: string; email: string } | null {
  const row = db.select({
    gitName: schema.userProfiles.gitName,
    gitEmail: schema.userProfiles.gitEmail,
  }).from(schema.userProfiles)
    .where(eq(schema.userProfiles.userId, userId)).get();
  if (!row?.gitName || !row?.gitEmail) return null;
  return { name: row.gitName, email: row.gitEmail };
}

/** Upsert the user's profile. */
export function updateProfile(userId: string, data: UpdateProfileRequest): UserProfile {
  const now = new Date().toISOString();
  const existing = db.select().from(schema.userProfiles)
    .where(eq(schema.userProfiles.userId, userId)).get();

  const encryptedToken = data.githubToken ? encrypt(data.githubToken) : null;

  if (existing) {
    const updates: Record<string, any> = { updatedAt: now };
    if (data.gitName !== undefined) updates.gitName = data.gitName || null;
    if (data.gitEmail !== undefined) updates.gitEmail = data.gitEmail || null;
    if (data.githubToken !== undefined) updates.githubToken = encryptedToken;
    db.update(schema.userProfiles).set(updates)
      .where(eq(schema.userProfiles.userId, userId)).run();
  } else {
    db.insert(schema.userProfiles).values({
      id: nanoid(),
      userId,
      gitName: data.gitName || null,
      gitEmail: data.gitEmail || null,
      githubToken: encryptedToken,
      createdAt: now,
      updatedAt: now,
    }).run();
  }

  return getProfile(userId)!;
}
