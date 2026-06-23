import {
  buildAgentExecutionProfileEnv,
  agentExecutionProfileConfigSchema,
  toAgentExecutionProfileResponse,
  type AgentExecutionProfile,
  type AgentExecutionProfileConfig,
  type AgentExecutionProfileResponse,
  type CreateAgentExecutionProfileRequest,
  type ProjectAgentProfileBindingResponse,
  type ResolvedAgentExecutionProfileResponse,
  type UpdateAgentExecutionProfileRequest,
} from '@funny/shared';
import { parseStoredJson } from '@funny/shared/json-validation';
import { and, asc, eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';

import { db, dbAll, dbGet, dbRun } from '../db/index.js';
import * as schema from '../db/schema.js';

type ProfileRow = typeof schema.agentExecutionProfiles.$inferSelect;
type BindingRow = typeof schema.projectAgentProfileBindings.$inferSelect;

function parseConfig(raw: string): AgentExecutionProfileConfig {
  const parsed = parseStoredJson(
    agentExecutionProfileConfigSchema,
    raw,
    'agent_execution_profiles.config',
  );
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}

function toProfile(row: ProfileRow): AgentExecutionProfile {
  return {
    id: row.id,
    userId: row.userId,
    name: row.name,
    provider: row.provider as AgentExecutionProfile['provider'],
    config: parseConfig(row.config),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function getProfileRow(id: string, userId: string): Promise<ProfileRow | undefined> {
  return dbGet(
    db
      .select()
      .from(schema.agentExecutionProfiles)
      .where(
        and(
          eq(schema.agentExecutionProfiles.id, id),
          eq(schema.agentExecutionProfiles.userId, userId),
        ),
      ),
  ) as Promise<ProfileRow | undefined>;
}

export async function listProfiles(userId: string): Promise<AgentExecutionProfileResponse[]> {
  const rows = (await dbAll(
    db
      .select()
      .from(schema.agentExecutionProfiles)
      .where(eq(schema.agentExecutionProfiles.userId, userId))
      .orderBy(
        asc(schema.agentExecutionProfiles.name),
        asc(schema.agentExecutionProfiles.createdAt),
      ),
  )) as ProfileRow[];

  return rows.map((row) => toAgentExecutionProfileResponse(toProfile(row)));
}

export async function getProfile(
  id: string,
  userId: string,
): Promise<AgentExecutionProfile | undefined> {
  const row = await getProfileRow(id, userId);
  return row ? toProfile(row) : undefined;
}

export async function createProfile(
  userId: string,
  input: CreateAgentExecutionProfileRequest,
): Promise<AgentExecutionProfileResponse> {
  const now = new Date().toISOString();
  const row = {
    id: nanoid(),
    userId,
    name: input.name,
    provider: input.provider,
    config: JSON.stringify(input.config),
    createdAt: now,
    updatedAt: now,
  };
  await dbRun(db.insert(schema.agentExecutionProfiles).values(row));
  return toAgentExecutionProfileResponse(toProfile(row));
}

export async function updateProfile(
  id: string,
  userId: string,
  input: UpdateAgentExecutionProfileRequest,
): Promise<AgentExecutionProfileResponse | null> {
  const existing = await getProfileRow(id, userId);
  if (!existing) return null;

  const updates: Partial<ProfileRow> = {
    updatedAt: new Date().toISOString(),
  };
  if (input.name !== undefined) updates.name = input.name;
  if (input.config !== undefined) updates.config = JSON.stringify(input.config);

  await dbRun(
    db
      .update(schema.agentExecutionProfiles)
      .set(updates)
      .where(
        and(
          eq(schema.agentExecutionProfiles.id, id),
          eq(schema.agentExecutionProfiles.userId, userId),
        ),
      ),
  );

  const updated = await getProfileRow(id, userId);
  return updated ? toAgentExecutionProfileResponse(toProfile(updated)) : null;
}

export async function deleteProfile(id: string, userId: string): Promise<boolean> {
  const existing = await getProfileRow(id, userId);
  if (!existing) return false;
  await dbRun(
    db
      .delete(schema.agentExecutionProfiles)
      .where(
        and(
          eq(schema.agentExecutionProfiles.id, id),
          eq(schema.agentExecutionProfiles.userId, userId),
        ),
      ),
  );
  return true;
}

export async function getProjectBinding(
  projectId: string,
  userId: string,
): Promise<ProjectAgentProfileBindingResponse> {
  const row = (await dbGet(
    db
      .select({
        binding: schema.projectAgentProfileBindings,
        profile: schema.agentExecutionProfiles,
      })
      .from(schema.projectAgentProfileBindings)
      .innerJoin(
        schema.agentExecutionProfiles,
        eq(schema.projectAgentProfileBindings.profileId, schema.agentExecutionProfiles.id),
      )
      .where(
        and(
          eq(schema.projectAgentProfileBindings.projectId, projectId),
          eq(schema.projectAgentProfileBindings.userId, userId),
          eq(schema.agentExecutionProfiles.userId, userId),
        ),
      ),
  )) as { binding: BindingRow; profile: ProfileRow } | undefined;

  return {
    projectId,
    profile: row ? toAgentExecutionProfileResponse(toProfile(row.profile)) : null,
  };
}

export async function setProjectBinding(
  projectId: string,
  userId: string,
  profileId: string | null,
): Promise<ProjectAgentProfileBindingResponse | null> {
  if (profileId === null) {
    await dbRun(
      db
        .delete(schema.projectAgentProfileBindings)
        .where(
          and(
            eq(schema.projectAgentProfileBindings.projectId, projectId),
            eq(schema.projectAgentProfileBindings.userId, userId),
          ),
        ),
    );
    return { projectId, profile: null };
  }

  const profile = await getProfileRow(profileId, userId);
  if (!profile) return null;

  const now = new Date().toISOString();
  await dbRun(
    db
      .insert(schema.projectAgentProfileBindings)
      .values({
        projectId,
        userId,
        profileId,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          schema.projectAgentProfileBindings.projectId,
          schema.projectAgentProfileBindings.userId,
        ],
        set: { profileId, updatedAt: now },
      }),
  );

  return {
    projectId,
    profile: toAgentExecutionProfileResponse(toProfile(profile)),
  };
}

export async function resolveEffectiveProfile(
  projectId: string,
  userId: string,
): Promise<ResolvedAgentExecutionProfileResponse> {
  const binding = await getProjectBinding(projectId, userId);
  if (!binding.profile) return { profile: null, env: {} };

  const profile = await getProfile(binding.profile.id, userId);
  if (!profile) return { profile: null, env: {} };

  return {
    profile: toAgentExecutionProfileResponse(profile),
    env: buildAgentExecutionProfileEnv(profile),
  };
}
