/**
 * Background activities (track-background-activities): inputs and answers of
 * the `activities` tRPC procedures. A user reads and removes only their own.
 */

import { z } from 'zod';

export const dismissActivityBody = z.object({ id: z.string().min(1).max(128) }).strict();

export type DismissActivityBody = z.input<typeof dismissActivityBody>;

/** What a removal answers: the ids it deleted. */
export interface RemovedActivities {
  ids: string[];
}
