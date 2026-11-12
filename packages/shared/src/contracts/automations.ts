/**
 * Automation input schemas: the `automations` tRPC procedures validate with
 * them, and the client's request types come from them.
 */

import { z } from 'zod';

const required = 'Missing required fields: projectId, name, prompt, schedule';

export const createAutomationBody = z.object({
  projectId: z.string().min(1, required),
  name: z.string().min(1, required),
  prompt: z.string().min(1, required),
  schedule: z.string().min(1, required),
  model: z.string().optional(),
  permissionMode: z.string().optional(),
});

// Security C1: strict allow-list. Ownership (`userId`), identity (`id`) and
// server-managed bookkeeping (`lastRunAt`, `nextRunAt`, `source`, timestamps)
// are never writable from the request body — unknown keys are rejected.
export const updateAutomationBody = z
  .object({
    projectId: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
    prompt: z.string().min(1).optional(),
    schedule: z.string().min(1).optional(),
    provider: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    mode: z.string().min(1).optional(),
    permissionMode: z.string().min(1).optional(),
    enabled: z.boolean().optional(),
    maxRunHistory: z.number().int().positive().optional(),
    baseBranch: z.string().nullable().optional(),
  })
  .strict();

export const runTriageStatus = z.enum(['pending', 'reviewed', 'dismissed'], {
  error: 'triageStatus must be one of: pending, reviewed, dismissed',
});

export const triageRunBody = z.object({ triageStatus: runTriageStatus });

export const listAutomationsQuery = z.object({ projectId: z.string().optional() });

export const automationInboxQuery = z.object({
  projectId: z.string().optional(),
  triageStatus: z.string().optional(),
});

export type CreateAutomationRequest = z.input<typeof createAutomationBody>;
export type UpdateAutomationRequest = z.input<typeof updateAutomationBody>;
