/**
 * User profile service for the central server.
 * Manages git identity and encrypted provider API keys.
 *
 * All provider keys (GitHub, MiniMax, AssemblyAI, etc.) are stored in a
 * single JSON column `provider_keys` as Record<string, encrypted_string>.
 * Each value is individually encrypted with AES-256-GCM.
 */

import type { UserProfile } from '@funny/shared';
import { eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';

import { db } from '../db/index.js';
import { userProfiles } from '../db/schema.js';
import { encrypt, decrypt } from '../lib/crypto.js';

// ── Helpers ──────────────────────────────────────────────────

/** Parse the provider_keys JSON column, returning {} on null/empty. */
function parseProviderKeys(raw: string | null): Record<string, string> {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/** Build the providerKeys presence map (id → boolean) for the API response. */
function buildPresenceMap(raw: string | null): Record<string, boolean> {
  const keys = parseProviderKeys(raw);
  const map: Record<string, boolean> = {};
  for (const k of Object.keys(keys)) {
    map[k] = true;
  }
  return map;
}

// ── Provider Key API ─────────────────────────────────────────

/** Get a single provider key by ID, decrypted. */
export async function getProviderKey(userId: string, provider: string): Promise<string | null> {
  const rows = await db.select().from(userProfiles).where(eq(userProfiles.userId, userId));
  const row = rows[0];
  if (!row) return null;

  const keys = parseProviderKeys(row.providerKeys);
  const encrypted = keys[provider];
  if (!encrypted) return null;
  return decrypt(encrypted);
}

/** Set (or clear) a provider key. */
export async function setProviderKey(
  userId: string,
  provider: string,
  value: string | null,
): Promise<void> {
  const rows = await db.select().from(userProfiles).where(eq(userProfiles.userId, userId));
  const row = rows[0];
  const now = new Date().toISOString();

  const existing = parseProviderKeys(row?.providerKeys ?? null);

  if (value) {
    existing[provider] = encrypt(value);
  } else {
    delete existing[provider];
  }

  const providerKeysJson = JSON.stringify(existing);

  if (row) {
    await db
      .update(userProfiles)
      .set({ providerKeys: providerKeysJson, updatedAt: now })
      .where(eq(userProfiles.userId, userId));
  } else {
    await db.insert(userProfiles).values({
      id: nanoid(),
      userId,
      providerKeys: providerKeysJson,
      setupCompleted: 0,
      createdAt: now,
      updatedAt: now,
    });
  }
}

// Thin wrappers kept for call-sites that still use the old names.
export async function getGithubToken(userId: string): Promise<string | null> {
  return getProviderKey(userId, 'github');
}
export async function getAssemblyaiApiKey(userId: string): Promise<string | null> {
  return getProviderKey(userId, 'assemblyai');
}
export async function getMinimaxApiKey(userId: string): Promise<string | null> {
  return getProviderKey(userId, 'minimax');
}

// ── Profile CRUD ─────────────────────────────────────────────

export async function getProfile(userId: string): Promise<UserProfile | null> {
  const rows = await db.select().from(userProfiles).where(eq(userProfiles.userId, userId));
  if (!rows[0]) return null;
  const r = rows[0];

  const providerKeys = buildPresenceMap(r.providerKeys);

  return {
    id: r.id,
    userId: r.userId,
    gitName: r.gitName,
    gitEmail: r.gitEmail,
    providerKeys,
    hasGithubToken: !!providerKeys.github,
    hasAssemblyaiKey: !!providerKeys.assemblyai,
    hasMinimaxApiKey: !!providerKeys.minimax,
    setupCompleted: !!r.setupCompleted,
    defaultEditor: r.defaultEditor ?? null,
    useInternalEditor: r.useInternalEditor != null ? !!r.useInternalEditor : null,
    terminalShell: r.terminalShell ?? null,
    toolPermissions: r.toolPermissions ? JSON.parse(r.toolPermissions as string) : null,
    theme: r.theme ?? null,
    runnerInviteToken: r.runnerInviteToken ?? null,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

export async function upsertProfile(
  userId: string,
  updates: {
    gitName?: string;
    gitEmail?: string;
    providerKey?: { id: string; value: string | null };
    githubToken?: string | null;
    assemblyaiApiKey?: string | null;
    minimaxApiKey?: string | null;
    setupCompleted?: boolean;
    defaultEditor?: string;
    useInternalEditor?: boolean;
    terminalShell?: string;
    toolPermissions?: Record<string, any>;
    theme?: string;
  },
): Promise<UserProfile> {
  // Handle provider keys (new generic + legacy fields)
  if (updates.providerKey) {
    await setProviderKey(userId, updates.providerKey.id, updates.providerKey.value);
  }
  if (updates.githubToken !== undefined) {
    await setProviderKey(userId, 'github', updates.githubToken);
  }
  if (updates.assemblyaiApiKey !== undefined) {
    await setProviderKey(userId, 'assemblyai', updates.assemblyaiApiKey);
  }
  if (updates.minimaxApiKey !== undefined) {
    await setProviderKey(userId, 'minimax', updates.minimaxApiKey);
  }

  const now = new Date().toISOString();
  const existing = await getProfile(userId);

  if (existing) {
    const set: Record<string, any> = { updatedAt: now };
    if (updates.gitName !== undefined) set.gitName = updates.gitName || null;
    if (updates.gitEmail !== undefined) set.gitEmail = updates.gitEmail || null;
    if (updates.setupCompleted !== undefined) set.setupCompleted = updates.setupCompleted ? 1 : 0;
    if (updates.defaultEditor !== undefined) set.defaultEditor = updates.defaultEditor;
    if (updates.useInternalEditor !== undefined)
      set.useInternalEditor = updates.useInternalEditor ? 1 : 0;
    if (updates.terminalShell !== undefined) set.terminalShell = updates.terminalShell;
    if (updates.toolPermissions !== undefined)
      set.toolPermissions = JSON.stringify(updates.toolPermissions);
    if (updates.theme !== undefined) set.theme = updates.theme;

    await db.update(userProfiles).set(set).where(eq(userProfiles.userId, userId));
  } else {
    await db.insert(userProfiles).values({
      id: nanoid(),
      userId,
      setupCompleted: updates.setupCompleted ? 1 : 0,
      gitName: updates.gitName ?? null,
      gitEmail: updates.gitEmail ?? null,
      defaultEditor: updates.defaultEditor ?? null,
      useInternalEditor:
        updates.useInternalEditor != null ? (updates.useInternalEditor ? 1 : 0) : null,
      terminalShell: updates.terminalShell ?? null,
      toolPermissions: updates.toolPermissions ? JSON.stringify(updates.toolPermissions) : null,
      theme: updates.theme ?? null,
      createdAt: now,
      updatedAt: now,
    });
  }

  return (await getProfile(userId))!;
}

export async function isSetupCompleted(userId: string): Promise<boolean> {
  const rows = await db.select().from(userProfiles).where(eq(userProfiles.userId, userId));
  return !!rows[0]?.setupCompleted;
}

// ── Runner Invite Token ─────────────────────────────────

/** Return the runner invite token for a user, generating one if it doesn't exist yet. */
export async function getOrCreateRunnerInviteToken(userId: string): Promise<string> {
  const rows = await db
    .select({ runnerInviteToken: userProfiles.runnerInviteToken })
    .from(userProfiles)
    .where(eq(userProfiles.userId, userId));

  if (rows[0]?.runnerInviteToken) return rows[0].runnerInviteToken;

  const token = `utkn_${nanoid(32)}`;
  const now = new Date().toISOString();

  if (rows.length > 0) {
    await db
      .update(userProfiles)
      .set({ runnerInviteToken: token, updatedAt: now })
      .where(eq(userProfiles.userId, userId));
  } else {
    await db.insert(userProfiles).values({
      id: nanoid(),
      userId,
      runnerInviteToken: token,
      setupCompleted: 0,
      createdAt: now,
      updatedAt: now,
    });
  }

  return token;
}

/** Regenerate the runner invite token, invalidating the previous one for new registrations. */
export async function rotateRunnerInviteToken(userId: string): Promise<string> {
  const token = `utkn_${nanoid(32)}`;
  const now = new Date().toISOString();

  const rows = await db
    .select({ id: userProfiles.id })
    .from(userProfiles)
    .where(eq(userProfiles.userId, userId));

  if (rows.length > 0) {
    await db
      .update(userProfiles)
      .set({ runnerInviteToken: token, updatedAt: now })
      .where(eq(userProfiles.userId, userId));
  } else {
    await db.insert(userProfiles).values({
      id: nanoid(),
      userId,
      runnerInviteToken: token,
      setupCompleted: 0,
      createdAt: now,
      updatedAt: now,
    });
  }

  return token;
}

/** Validate a runner invite token and return the userId it belongs to, or null if invalid. */
export async function validateRunnerInviteToken(token: string): Promise<string | null> {
  const rows = await db
    .select({ userId: userProfiles.userId })
    .from(userProfiles)
    .where(eq(userProfiles.runnerInviteToken, token));
  return rows[0]?.userId ?? null;
}
