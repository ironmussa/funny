/**
 * The URL a sandbox runner uses to reach this server (change thread-sandboxes).
 * Remote sandboxes need a publicly reachable origin: an explicit
 * `FUNNY_PUBLIC_URL`, or the domain Railway injects. Loopback and private
 * addresses are refused — a sandbox on the internet could never reach them.
 */

import { err, ok, type Result } from 'neverthrow';

export type PublicServerUrlError = { kind: 'no-public-url'; message: string };

const PRIVATE_HOST =
  /^(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$|.*\.internal$|.*\.local$)/i;

export function resolvePublicServerUrl(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Result<string, PublicServerUrlError> {
  const raw =
    env.FUNNY_PUBLIC_URL?.trim() ||
    (env.RAILWAY_PUBLIC_DOMAIN?.trim() ? `https://${env.RAILWAY_PUBLIC_DOMAIN.trim()}` : '');
  const fail = (message: string) =>
    err<string, PublicServerUrlError>({ kind: 'no-public-url', message });
  if (!raw) {
    return fail('Sandboxes need the publicly hosted funny server (set FUNNY_PUBLIC_URL).');
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return fail(`FUNNY_PUBLIC_URL is not a valid URL: ${raw}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return fail('Unsupported URL scheme');
  if (PRIVATE_HOST.test(url.hostname)) {
    return fail(`${url.hostname} is not reachable from a remote sandbox`);
  }
  return ok(url.origin);
}
