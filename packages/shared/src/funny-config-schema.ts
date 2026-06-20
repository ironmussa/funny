import { z } from 'zod';

import type { FunnyProjectConfig } from './types/funny-config.js';

export const funnyPortGroupSchema = z.object({
  name: z.string().min(1),
  basePort: z.number().int(),
  envVars: z.array(z.string()),
});

export const funnyProcessConfigSchema = z.object({
  name: z.string().min(1),
  command: z.string().min(1),
  autoRestart: z.boolean().optional(),
  maxRestarts: z.number().int().positive().optional(),
  restartWindowSec: z.number().int().positive().optional(),
});

export const funnyAutomationConfigSchema = z.object({
  name: z.string().min(1),
  prompt: z.string().min(1),
  schedule: z.string().min(1),
  provider: z.string().optional(),
  model: z.string().optional(),
  permissionMode: z.string().optional(),
});

export const funnyProjectConfigSchema = z
  .object({
    envFiles: z.array(z.string()).optional(),
    portGroups: z.array(funnyPortGroupSchema).optional(),
    postCreate: z.array(z.string()).optional(),
    processes: z.array(funnyProcessConfigSchema).optional(),
    automations: z.array(funnyAutomationConfigSchema).optional(),
  })
  .passthrough();

export type ValidatedFunnyProjectConfig = z.infer<typeof funnyProjectConfigSchema>;

const _assertSchemaMatchesContract: FunnyProjectConfig = {} as ValidatedFunnyProjectConfig;
void _assertSchemaMatchesContract;
