/**
 * The machine a sandbox launch request may name (change thread-sandboxes):
 * shared by the infra provision route and sandbox thread creation, which also
 * lets the connection be omitted to use the project sandbox (project-sandboxes).
 */

import { z } from 'zod';

export const sandboxMachineRequestSchema = z
  .object({
    connectionId: z.string().min(1),
    sizeId: z.string().min(1).max(32).optional(),
    /** Repository to clone; defaults to the project's origin read from its runner. */
    repoUrl: z.string().min(1).max(2048).optional(),
  })
  .strict();
