/**
 * Design input schemas (served over tRPC, `@funny/api` `designs` router, and by
 * the REST routes under `/api/projects/:id/designs` and `/api/designs/:id`).
 */

import { z } from 'zod';

import type { DesignFidelity, DesignType } from '../types.js';

const DESIGN_TYPES = ['prototype', 'slides', 'template', 'other'] as const satisfies DesignType[];
const DESIGN_FIDELITIES = ['wireframe', 'high'] as const satisfies DesignFidelity[];

export const createDesignBody = z.object({
  name: z
    .string({ error: 'name is required' })
    .trim()
    .min(1, 'name is required')
    .max(200, 'name must be ≤ 200 chars'),
  type: z.enum(DESIGN_TYPES, { error: `type must be one of: ${DESIGN_TYPES.join(', ')}` }),
  fidelity: z
    .enum(DESIGN_FIDELITIES, {
      error: `fidelity must be one of: ${DESIGN_FIDELITIES.join(', ')}`,
    })
    .nullable()
    .optional(),
  speakerNotes: z.boolean().optional(),
});

export type CreateDesignRequest = z.input<typeof createDesignBody>;
export type CreateDesignBody = z.output<typeof createDesignBody>;
