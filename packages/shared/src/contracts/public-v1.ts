/**
 * The public REST API v1 (openspec public-rest-api-v1): inputs and published
 * outputs. Every field here is a public contract: an output schema lists
 * exactly what a response may carry, and undeclared fields are stripped.
 */

import { z } from 'zod';

/** A project as the public API shows it: never its path on a runner's disk. */
export const publicProject = z.object({
  id: z.string(),
  name: z.string(),
  color: z.string().optional(),
  /** URL patterns that resolve a page to this project. */
  urls: z.array(z.string()).optional(),
  /** Shared with the caller by its owner (not owned by the caller). */
  shared: z.boolean(),
});

export const publicProjectList = z.object({ projects: z.array(publicProject) });

export const resolveProjectInput = z.object({
  /** The page URL to match against each project's URL patterns. */
  url: z.string().min(1).max(2048),
});

export const resolveProjectOutput = z.object({
  project: publicProject.nullable(),
  source: z.enum(['url_match', 'none']),
});

export type PublicProject = z.output<typeof publicProject>;
