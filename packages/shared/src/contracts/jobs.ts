/**
 * Input of the `jobs.list` tRPC procedure: one page of the caller's jobs,
 * newest first. A missing input is the first page.
 */

import { z } from 'zod';

export const jobListInput = z
  .object({
    limit: z.number().int().min(1).max(500).default(100),
    offset: z.number().int().min(0).default(0),
  })
  .default({ limit: 100, offset: 0 });

export type JobListRequest = z.input<typeof jobListInput>;
export type JobListPage = z.output<typeof jobListInput>;
