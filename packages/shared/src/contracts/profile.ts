/**
 * `/api/profile` input schemas (served over tRPC, `@funny/api` `profile` router).
 * `updateProfileBody` is `UpdateProfileRequest` as a schema; unknown keys are
 * dropped, as the REST route always ignored them.
 */

import { z } from 'zod';

import type { UpdateProfileRequest, UserProfile } from '../types/auth.js';

/** The backends a helper generation (thread recap, commit message) can run on. */
export const UTILITY_MODEL_PROVIDERS = [
  'claude-sdk',
  'anthropic',
  'openai',
  'ollama',
  'openai-compatible',
] as const;

/** Providers that take a `baseURL`; `openai-compatible` cannot work without one. */
const BASE_URL_PROVIDERS: ReadonlySet<string> = new Set(['ollama', 'openai-compatible']);

/**
 * The model a user picked for helper generations (openspec `thread-recap`, D4),
 * stored as JSON in `user_profiles.utility_model`. `null` means the default,
 * see `resolveUtilityModel`.
 */
export const UtilityModelSetting = z
  .object({
    provider: z.enum(UTILITY_MODEL_PROVIDERS),
    model: z.string().min(1),
    baseURL: z.string().min(1).optional(),
  })
  .superRefine((setting, ctx) => {
    if (setting.provider === 'openai-compatible' && !setting.baseURL) {
      ctx.addIssue({
        code: 'custom',
        path: ['baseURL'],
        message: 'baseURL is required for an openai-compatible provider',
      });
    } else if (setting.baseURL !== undefined && !BASE_URL_PROVIDERS.has(setting.provider)) {
      ctx.addIssue({
        code: 'custom',
        path: ['baseURL'],
        message: `baseURL is not used by the ${setting.provider} provider`,
      });
    }
  });

export type UtilityModelSetting = z.infer<typeof UtilityModelSetting>;

const DEFAULT_UTILITY_MODEL: UtilityModelSetting = { provider: 'claude-sdk', model: 'haiku' };

/** The model a helper generation runs on: the user's setting, or Claude Haiku. */
export function resolveUtilityModel(setting: UtilityModelSetting | null): UtilityModelSetting {
  return setting ?? { ...DEFAULT_UTILITY_MODEL };
}

/** Default absence (minutes) before a thread recap is offered (thread-recap). */
export const DEFAULT_THREAD_RECAP_MIN_ABSENCE_MINUTES = 5;

/** Accepted range for `threadRecapMinAbsenceMinutes`: one minute to one day. */
export const THREAD_RECAP_MIN_ABSENCE_LIMITS = { min: 1, max: 1440 } as const;

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
  utilityModel: UtilityModelSetting.nullable().optional(),
  threadRecapEnabled: z.boolean().optional(),
  threadRecapMinAbsenceMinutes: z
    .number()
    .int()
    .min(THREAD_RECAP_MIN_ABSENCE_LIMITS.min)
    .max(THREAD_RECAP_MIN_ABSENCE_LIMITS.max)
    .optional(),
}) satisfies z.ZodType<UpdateProfileRequest>;

/**
 * The profile of a user who never saved one has no row yet: the server answers
 * the defaults, without `id` and timestamps.
 */
export type ProfileResponse = UserProfile | Omit<UserProfile, 'id' | 'createdAt' | 'updatedAt'>;
