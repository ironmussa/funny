import { z } from 'zod';

import type { AgentProvider } from '../primitives.js';

export const agentExecutionProfileProviderSchema = z.literal('claude');

export const claudeExecutionProfileConfigSchema = z.object({
  configDir: z.string().min(1).max(4096),
});

export const agentExecutionProfileConfigSchema = z.object({
  claude: claudeExecutionProfileConfigSchema,
});

export const createAgentExecutionProfileSchema = z.object({
  name: z.string().trim().min(1).max(120),
  provider: agentExecutionProfileProviderSchema.default('claude'),
  config: agentExecutionProfileConfigSchema,
});

export const updateAgentExecutionProfileSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    config: agentExecutionProfileConfigSchema.optional(),
  })
  .refine((value) => value.name !== undefined || value.config !== undefined, {
    message: 'At least one field is required',
  });

export const updateProjectAgentProfileBindingSchema = z.object({
  profileId: z.string().min(1).nullable(),
});

export type AgentExecutionProfileProvider = z.infer<typeof agentExecutionProfileProviderSchema>;
export type ClaudeExecutionProfileConfig = z.infer<typeof claudeExecutionProfileConfigSchema>;
export type AgentExecutionProfileConfig = z.infer<typeof agentExecutionProfileConfigSchema>;
export type CreateAgentExecutionProfileRequest = z.infer<typeof createAgentExecutionProfileSchema>;
export type UpdateAgentExecutionProfileRequest = z.infer<typeof updateAgentExecutionProfileSchema>;
export type UpdateProjectAgentProfileBindingRequest = z.infer<
  typeof updateProjectAgentProfileBindingSchema
>;

export interface AgentExecutionProfile {
  id: string;
  userId: string;
  name: string;
  provider: AgentProvider;
  config: AgentExecutionProfileConfig;
  createdAt: string;
  updatedAt: string;
}

export interface AgentExecutionProfileResponse {
  id: string;
  name: string;
  provider: AgentProvider;
  config: AgentExecutionProfileConfig;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectAgentProfileBinding {
  projectId: string;
  userId: string;
  profileId: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectAgentProfileBindingResponse {
  projectId: string;
  profile: AgentExecutionProfileResponse | null;
}

export interface ResolvedAgentExecutionProfile {
  profile: AgentExecutionProfile;
  env: Record<string, string>;
}

export interface ResolvedAgentExecutionProfileResponse {
  profile: AgentExecutionProfileResponse | null;
  env: Record<string, string>;
}

export interface ThreadResolvedAgentProfileSnapshot {
  profileId: string;
  profileName: string;
  provider: AgentProvider;
}

export function toAgentExecutionProfileResponse(
  profile: AgentExecutionProfile,
): AgentExecutionProfileResponse {
  return {
    id: profile.id,
    name: profile.name,
    provider: profile.provider,
    config: profile.config,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
  };
}

export function buildAgentExecutionProfileEnv(
  profile: AgentExecutionProfile,
): Record<string, string> {
  if (profile.provider === 'claude') {
    return { CLAUDE_CONFIG_DIR: profile.config.claude.configDir };
  }
  return {};
}
