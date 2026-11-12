/**
 * Pipeline CRUD input schemas: the `pipelines` tRPC procedures validate with
 * them, and the client's request types come from them.
 */

import { z } from 'zod';

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
