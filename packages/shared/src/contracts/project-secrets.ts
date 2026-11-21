/**
 * Project secrets (openspec `project-secrets`): inputs and answers of the
 * `projectSecrets` tRPC procedures. A value goes in and never comes back: no
 * answer type here has a value field.
 */

import { z } from 'zod';

import {
  secretNameMessage,
  secretValueMessage,
  validateSecretName,
  validateSecretValue,
} from '../project-secrets.js';

const projectId = z.string().min(1);

export const projectSecretScope = z.enum(['project', 'user']);

const secretName = z.string().superRefine((name, ctx) => {
  const problem = validateSecretName(name);
  if (problem) ctx.addIssue({ code: 'custom', message: secretNameMessage(problem) });
});

const secretValue = z.string().superRefine((value, ctx) => {
  const problem = validateSecretValue(value);
  if (problem) ctx.addIssue({ code: 'custom', message: secretValueMessage(problem) });
});

export const listProjectSecretsInput = z.object({ projectId }).strict();

/**
 * Creates the secret, or changes the one with this name and scope. `value` may
 * be left out for a secret that exists, to change only its sandbox setting.
 */
export const setProjectSecretInput = z
  .object({
    projectId,
    scope: projectSecretScope,
    name: secretName,
    value: secretValue.optional(),
    allowInSandbox: z.boolean(),
  })
  .strict();

export type SetProjectSecretInput = z.input<typeof setProjectSecretInput>;

export const deleteProjectSecretInput = z.object({ projectId, id: z.string().min(1) }).strict();

/** A secret as listed: its name and settings, never its value. */
export interface ProjectSecretSummary {
  id: string;
  name: string;
  /** `project`: shared by the project's members. `user`: the caller's own. */
  scope: 'project' | 'user';
  allowInSandbox: boolean;
  /** User id of whoever last saved it. */
  updatedBy: string;
  updatedAt: string;
}
