/**
 * `/api/profile` input schemas (served over tRPC, `@funny/api` `profile` router).
 * `updateProfileBody` is `UpdateProfileRequest` as a schema; unknown keys are
 * dropped, as the REST route always ignored them.
 */

import { z } from 'zod';

import type { UpdateProfileRequest, UserProfile } from '../types/auth.js';

export const updateProfileBody = z.object({
  gitName: z.string().optional(),
  gitEmail: z.string().optional(),
  providerKey: z.object({ id: z.string().min(1), value: z.string().nullable() }).optional(),
  githubToken: z.string().nullable().optional(),
  assemblyaiApiKey: z.string().nullable().optional(),
  minimaxApiKey: z.string().nullable().optional(),
  setupCompleted: z.boolean().optional(),
  defaultEditor: z.string().optional(),
  useInternalEditor: z.boolean().optional(),
  terminalShell: z.string().optional(),
  toolPermissions: z.record(z.string(), z.string()).optional(),
  theme: z.string().optional(),
}) satisfies z.ZodType<UpdateProfileRequest>;

/**
 * The profile of a user who never saved one has no row yet: the server answers
 * the defaults, without `id` and timestamps.
 */
export type ProfileResponse = UserProfile | Omit<UserProfile, 'id' | 'createdAt' | 'updatedAt'>;
