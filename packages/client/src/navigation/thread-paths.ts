/**
 * Path builders for thread routes.
 *
 * Single place that combines the scratch-aware route shape
 * (`getThreadRoute`) with the active-org prefix (`buildPath`). UI code that
 * needs a thread URL — `navigate(...)`, `<Link to={...} />`, `href={...}` —
 * MUST go through `buildThreadPath` instead of hand-rolling
 * `/projects/${projectId}/threads/${id}`, so scratch threads and the org
 * prefix stay correct in one spot.
 *
 * Part of the route-driven-threads migration — see
 * `docs/route-driven-threads-plan.md`.
 */

import type { Thread } from '@funny/shared';

import { getThreadRoute } from '@/lib/thread-variant';
import { buildPath } from '@/lib/url';

/** The minimal thread shape needed to build a detail route. */
export type ThreadRouteTarget = Pick<Thread, 'id' | 'projectId' | 'isScratch'>;

/**
 * App-internal, org-prefixed path to a thread's detail view.
 * Scratch threads → `/scratch/:id`; normal → `/projects/:projectId/threads/:id`.
 */
export function buildThreadPath(thread: ThreadRouteTarget): string {
  return buildPath(getThreadRoute(thread));
}
