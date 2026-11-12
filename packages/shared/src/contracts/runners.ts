/**
 * Input schemas of the runner routes a user calls and the server answers itself
 * (served over tRPC, `@funny/api` `runners` and `projectRunners` routers, and by
 * the REST routes). What a runner calls with its own credential (register,
 * enrollment start / poll, heartbeat, tasks) stays REST.
 */

import { z } from 'zod';

export const assignRunnerProjectBody = z.object({
  projectId: z.string().min(1, 'Missing required fields: projectId, localPath'),
  /** The local path on the runner machine where this project repo lives. */
  localPath: z.string().min(1, 'Missing required fields: projectId, localPath'),
});

export const approveEnrollmentBody = z.object({
  userCode: z.string().min(1, 'Missing userCode'),
});

export const updateProjectRunnerSettingsBody = z.object({
  dedicatedRunnerId: z.string().min(1).nullable().optional(),
  /** Plaintext token to store (encrypted); `null` clears it; omitted = unchanged. */
  githubToken: z.string().min(1).max(512).nullable().optional(),
});

export const setGeneralRunnerBody = z.object({
  /** `null` clears the user's general runner. */
  runnerId: z.string().min(1).nullable(),
});

export type AssignRunnerProjectBody = z.output<typeof assignRunnerProjectBody>;
export type UpdateProjectRunnerSettingsBody = z.output<typeof updateProjectRunnerSettingsBody>;
