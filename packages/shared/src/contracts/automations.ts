/**
 * `/api/automations` contract: the input schemas the server validates with and
 * the response types it must return. The client calls these endpoints, so the
 * request and response types on both sides come from this file.
 */

import { z } from 'zod';

import type { Automation, AutomationRun, InboxItem } from '../types/automations.js';
import { endpointGroup } from './endpoint.js';

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

type Ok = { ok: true };

const api = endpointGroup('/automations');

export const automationsContract = {
  // Declared before `get` so `/inbox` is not read as an automation id.
  inbox: api.endpoint<InboxItem[]>()({
    method: 'GET',
    path: '/inbox',
    query: automationInboxQuery,
  }),
  list: api.endpoint<Automation[]>()({ method: 'GET', path: '/', query: listAutomationsQuery }),
  get: api.endpoint<Automation>()({ method: 'GET', path: '/:id' }),
  create: api.endpoint<Automation>()({ method: 'POST', path: '/', body: createAutomationBody }),
  update: api.endpoint<Automation>()({
    method: 'PATCH',
    path: '/:id',
    body: updateAutomationBody,
  }),
  remove: api.endpoint<Ok>()({ method: 'DELETE', path: '/:id' }),
  trigger: api.endpoint<Ok & { runId: string; threadId: string }>()({
    method: 'POST',
    path: '/:id/trigger',
  }),
  runs: api.endpoint<AutomationRun[]>()({ method: 'GET', path: '/:id/runs' }),
  triageRun: api.endpoint<Ok>()({
    method: 'PATCH',
    path: '/runs/:runId/triage',
    body: triageRunBody,
  }),
};
