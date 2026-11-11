/**
 * `/api/pipelines` contract for the pipeline CRUD and run history the server
 * answers from its own DB. The approval gates and the scheduler callbacks are
 * not covered here.
 */

import { z } from 'zod';

import type { Pipeline, PipelineRun } from '../types/pipelines.js';
import { endpointGroup } from './endpoint.js';

const promptFields = {
  reviewerPrompt: z.string().optional(),
  correctorPrompt: z.string().optional(),
  precommitFixerPrompt: z.string().optional(),
  commitMessagePrompt: z.string().optional(),
  testFixerPrompt: z.string().optional(),
};

const settingsFields = {
  reviewModel: z.string().optional(),
  fixModel: z.string().optional(),
  maxIterations: z.number().optional(),
  precommitFixEnabled: z.boolean().optional(),
  precommitFixModel: z.string().optional(),
  precommitFixMaxIterations: z.number().optional(),
  testEnabled: z.boolean().optional(),
  testCommand: z.string().optional(),
  testFixEnabled: z.boolean().optional(),
  testFixModel: z.string().optional(),
  testFixMaxIterations: z.number().optional(),
  ...promptFields,
};

const required = 'projectId and name are required';

// Unknown keys are dropped, as before.
export const createPipelineBody = z.object({
  projectId: z.string({ error: required }).min(1, required),
  name: z.string({ error: required }).min(1, required),
  ...settingsFields,
});

export const updatePipelineBody = z.object({
  name: z.string().optional(),
  enabled: z.boolean().optional(),
  ...settingsFields,
});

export type CreatePipelineRequest = z.input<typeof createPipelineBody>;
export type UpdatePipelineRequest = z.input<typeof updatePipelineBody>;

const api = endpointGroup('/pipelines');

export const pipelinesContract = {
  list: api.endpoint<Pipeline[]>()({ method: 'GET', path: '/project/:projectId' }),
  get: api.endpoint<Pipeline>()({ method: 'GET', path: '/:id' }),
  create: api.endpoint<Pipeline>()({ method: 'POST', path: '/', body: createPipelineBody }),
  update: api.endpoint<Pipeline>()({ method: 'PATCH', path: '/:id', body: updatePipelineBody }),
  remove: api.endpoint<{ ok: true }>()({ method: 'DELETE', path: '/:id' }),
  runsForThread: api.endpoint<PipelineRun[]>()({ method: 'GET', path: '/runs/thread/:threadId' }),
};
