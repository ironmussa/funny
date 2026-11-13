/**
 * Server-answered REST groups the web client now reaches over tRPC only
 * (openspec adopt-trpc-browser-api, task 6.1), plus removed server routes.
 *
 * Without a server route these paths would fall through to the runner proxy
 * catch-all and be forwarded to the user's runner, which does not own the rows
 * (and, when it serves the client bundle, answers unknown GETs with its SPA
 * page). Refusing them here keeps the decision on the server: a retired path
 * answers 404 and never reaches a runner.
 *
 * Paths that stay proxied on purpose are NOT listed: GitHub's App manifest
 * callback `/api/settings/github-app/callback` (mounted earlier, still REST),
 * `/api/jobs/:id/log` and `/api/jobs/:id/cancel` (the runner owns the
 * process), and the design folder routes
 * `/api/projects/:id/designs/directory` and
 * `/api/projects/:id/designs/:designId/directory` (the runner owns the folder).
 */

import type { Context, Hono } from 'hono';

import type { ServerEnv } from '../lib/types.js';

const RETIRED_PREFIXES = [
  '/api/automations',
  '/api/settings',
  '/api/agent-templates',
  '/api/watchers',
  '/api/designs',
  '/api/analytics',
  '/api/push',
  // Removed outright (#196): the org had no columns for its fields and Better
  // Auth refused `updateOrganization` for every role. Per-user keys live in the profile.
  '/api/team-settings',
] as const;

/** The answer of every retired REST path (also used by routes that retire some of their sub-paths). */
export const refuseRetiredRoute = (c: Context<ServerEnv>) => c.json({ error: 'Not found' }, 404);
const notFound = refuseRetiredRoute;

/**
 * Mount AFTER every server route that shares these prefixes (the GitHub App
 * settings) and BEFORE the runner proxy catch-all.
 */
export function refuseRetiredRestRoutes(app: Hono<ServerEnv>): void {
  for (const prefix of RETIRED_PREFIXES) {
    app.all(prefix, notFound);
    app.all(`${prefix}/*`, notFound);
  }
  // The bare job list only; the job log and cancel stay proxied (routes/jobs.ts).
  app.get('/api/jobs', notFound);
  // The design rows of a project; the folder routes below it stay proxied.
  app.on(['GET', 'POST'], '/api/projects/:id/designs', notFound);
}
