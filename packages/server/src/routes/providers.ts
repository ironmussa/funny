import { Hono } from 'hono';

import type { ServerEnv } from '../lib/types.js';
import {
  findAnyRunnerForUser,
  getActiveBuiltinsForUser,
  getAdvertisedProvidersForUser,
  getAvailableProvidersForUser,
} from '../services/runner-manager.js';

/**
 * `/api/providers` — the runner-installed (external) agent providers available
 * to the requesting user, advertised by their online runner
 * (provider-manifest-loader §3). Per-runner by design: two users with different
 * runners see different provider sets. The client merges these with its static
 * built-in providers in the model picker. The spawn command + quirks never reach
 * the server (runner-owned trust model) — only the public face is returned.
 */
export const providerRoutes = new Hono<ServerEnv>();

providerRoutes.get('/', async (c) => {
  const userId = c.get('userId') as string | undefined;
  c.header('Cache-Control', 'no-store');
  if (!userId)
    return c.json({ providers: [], activeBuiltins: null, availableProviders: null, hasRunner: false });
  const [providers, activeBuiltins, availableProviders, runnerId] = await Promise.all([
    getAdvertisedProvidersForUser(userId),
    getActiveBuiltinsForUser(userId),
    getAvailableProvidersForUser(userId),
    findAnyRunnerForUser(userId),
  ]);
  // hasRunner distinguishes "no runner → no-runner state" from "runner online but
  // didn't advertise availability (old runner) → unknown, don't gate".
  return c.json({ providers, activeBuiltins, availableProviders, hasRunner: runnerId !== null });
});
