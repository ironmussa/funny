/**
 * `/api/push` input schemas (served over tRPC, `@funny/api` `push` router, and
 * by the REST routes).
 */

import { z } from 'zod';

const PUSH_HOSTS = new Set([
  'fcm.googleapis.com',
  'updates.push.services.mozilla.com',
  'web.push.apple.com',
]);
const PUSH_HOST_SUFFIXES = ['.push.services.mozilla.com', '.notify.windows.com'];

const isPushHost = (hostname: string) =>
  PUSH_HOSTS.has(hostname) || PUSH_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix));

/** HTTPS, with no credentials and no explicit port. */
const isPlainHttps = (url: URL) =>
  url.protocol === 'https:' && !url.username && !url.password && !url.port;

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/** Outbound requests go to browser push providers only; never to arbitrary URLs. */
export function isPushEndpoint(value: string): boolean {
  const url = parseUrl(value);
  return !!url && isPlainHttps(url) && isPushHost(url.hostname);
}

export const pushSubscriptionBody = z.object({
  endpoint: z.string().max(4096).refine(isPushEndpoint),
  keys: z.object({
    p256dh: z.string().regex(/^[A-Za-z0-9_-]{87}$/),
    auth: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
  }),
});

export const pushEndpointBody = z.object({ endpoint: z.string().max(4096) });

export type PushSubscriptionBody = z.output<typeof pushSubscriptionBody>;
