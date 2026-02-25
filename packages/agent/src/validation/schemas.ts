import { z } from 'zod';

export const StartSessionSchema = z.object({
  issue_number: z.number().int().min(1).optional(),
  prompt: z.string().min(1).optional(),
  project_path: z.string().min(1).optional(),
});

export type StartSessionInput = z.infer<typeof StartSessionSchema>;
