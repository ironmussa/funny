/**
 * HTTP reverse proxy middleware for the central server.
 *
 * Any /api/* route not handled by native server routes gets forwarded
 * to the appropriate runner. The runner is resolved by extracting
 * projectId or threadId from the request.
 *
 * Headers added to proxied requests:
 * - X-Forwarded-User: userId from the authenticated session
 * - X-Forwarded-Org: organizationId (if present)
 * - X-Runner-Auth: shared secret so the runner trusts the server
 */

import type { Context } from 'hono';

import { log } from '../lib/logger.js';
import type { ServerEnv } from '../lib/types.js';
import { resolveRunnerUrl } from '../services/runner-resolver.js';

const RUNNER_AUTH_SECRET = process.env.RUNNER_AUTH_SECRET || 'funny-server-proxy';

/**
 * Hono handler that proxies the request to the appropriate runner.
 * Used as a catch-all: `app.all('/api/*', proxyToRunner)`
 */
export async function proxyToRunner(c: Context<ServerEnv>): Promise<Response> {
  const userId = c.get('userId') as string | undefined;
  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const url = new URL(c.req.url);
  const path = url.pathname;
  const query = Object.fromEntries(url.searchParams.entries());

  // Resolve which runner should handle this request
  const runnerUrl = await resolveRunnerUrl(path, query);

  if (!runnerUrl) {
    return c.json(
      {
        error:
          'No runner available for this request. Check that a runner is online and assigned to the project.',
      },
      502,
    );
  }

  // Build the target URL: runner base URL + original path + query
  const targetUrl = `${runnerUrl}${path}${url.search}`;

  try {
    // Forward the request to the runner
    const headers = new Headers(c.req.raw.headers);
    headers.set('X-Forwarded-User', userId);
    headers.set('X-Runner-Auth', RUNNER_AUTH_SECRET);

    const orgId = c.get('organizationId') as string | undefined;
    if (orgId) {
      headers.set('X-Forwarded-Org', orgId);
    }

    // Remove cookie/auth headers — the runner uses X-Forwarded-User instead
    headers.delete('cookie');
    headers.delete('authorization');

    const runnerResponse = await fetch(targetUrl, {
      method: c.req.method,
      headers,
      body: c.req.method !== 'GET' && c.req.method !== 'HEAD' ? c.req.raw.body : undefined,
      // @ts-expect-error - Bun supports duplex
      duplex: c.req.method !== 'GET' && c.req.method !== 'HEAD' ? 'half' : undefined,
    });

    // Relay the response back to the browser
    return new Response(runnerResponse.body, {
      status: runnerResponse.status,
      statusText: runnerResponse.statusText,
      headers: runnerResponse.headers,
    });
  } catch (err) {
    log.error('Failed to proxy request to runner', {
      namespace: 'proxy',
      targetUrl,
      error: (err as Error).message,
    });
    return c.json({ error: 'Runner unreachable' }, 502);
  }
}
