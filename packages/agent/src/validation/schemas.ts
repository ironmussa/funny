import { z } from 'zod';

const TierSchema = z.enum(['small', 'medium', 'large']);

const AgentNameSchema = z.enum([
  'tests', 'security', 'architecture', 'performance',
  'style', 'types', 'docs', 'integration',
]);

const PipelineConfigSchema = z.object({
  tier: TierSchema.optional(),
  agents: z.array(AgentNameSchema).min(1).optional(),
  model: z.string().optional(),
  maxTurns: z.number().int().min(1).max(500).optional(),
  skip_merge: z.boolean().optional(),
}).optional();

export const PipelineRunSchema = z.object({
  branch: z.string()
    .min(1, 'branch is required')
    .refine((b) => !b.startsWith('pipeline/'), {
      message: 'branch must not start with "pipeline/"',
    }),
  worktree_path: z.string().min(1, 'worktree_path is required'),
  projectId: z.string().optional(),
  base_branch: z.string().optional(),
  config: PipelineConfigSchema,
  metadata: z.record(z.unknown()).optional(),
});

export type PipelineRunInput = z.infer<typeof PipelineRunSchema>;

export const DirectorRunSchema = z.object({
  project_path: z.string().optional(),
}).optional();
