/**
 * User profile service for the central server.
 * Manages git identity and encrypted GitHub tokens.
 */

import { eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';

import { db } from '../db/index.js';
import { userProfiles } from '../db/schema.js';
import { encrypt, decrypt } from '../lib/crypto.js';

export interface UserProfile {
  userId: string;
  gitName: string | null;
  gitEmail: string | null;
  hasGithubToken: boolean;
}

export async function getProfile(userId: string): Promise<UserProfile | null> {
  const rows = await db.select().from(userProfiles).where(eq(userProfiles.userId, userId));

  if (!rows[0]) return null;
  const r = rows[0];

  return {
    userId: r.userId,
    gitName: r.gitName,
    gitEmail: r.gitEmail,
    hasGithubToken: !!r.githubToken,
  };
}

export async function upsertProfile(
  userId: string,
  updates: { gitName?: string; gitEmail?: string; githubToken?: string },
): Promise<UserProfile> {
  const now = new Date().toISOString();
  const existing = await getProfile(userId);

  const githubTokenValue = updates.githubToken ? encrypt(updates.githubToken) : undefined;

  if (existing) {
    const set: Record<string, any> = { updatedAt: now };
    if (updates.gitName !== undefined) set.gitName = updates.gitName;
    if (updates.gitEmail !== undefined) set.gitEmail = updates.gitEmail;
    if (githubTokenValue !== undefined) set.githubToken = githubTokenValue;

    await db.update(userProfiles).set(set).where(eq(userProfiles.userId, userId));
  } else {
    await db.insert(userProfiles).values({
      id: nanoid(),
      userId,
      gitName: updates.gitName ?? null,
      gitEmail: updates.gitEmail ?? null,
      githubToken: githubTokenValue ?? null,
      createdAt: now,
      updatedAt: now,
    });
  }

  return (await getProfile(userId))!;
}

export async function getGithubToken(userId: string): Promise<string | null> {
  const rows = await db
    .select({ githubToken: userProfiles.githubToken })
    .from(userProfiles)
    .where(eq(userProfiles.userId, userId));

  const encrypted = rows[0]?.githubToken;
  if (!encrypted) return null;
  return decrypt(encrypted);
}
