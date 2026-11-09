/**
 * How a sandbox runner reaches this server (change thread-sandboxes).
 *
 *   - `direct`: the runner dials the server's public URL (`FUNNY_PUBLIC_URL`,
 *     Railway's domain). Needs a server reachable from the internet.
 *   - `reverse`: the server dials into the sandbox through a port the provider
 *     publishes (`SandboxProvider.exposePort`); the runner's server origin is
 *     the relay's loopback port (`@funny/shared/reverse-link`). Works for a
 *     server on a laptop, with any provider that can publish a port.
 *
 * The link is chosen once per sandbox, persisted on its row, and nothing else
 * branches on the provider: a new provider gets the reverse link by
 * implementing `exposePort`, and a new kind of link is a new case here.
 */

import { createHmac } from 'node:crypto';

import { REVERSE_LINK_LOOPBACK_PORT, REVERSE_LINK_SECRET_ENV } from '@funny/shared/reverse-link';
import { err, ok, type Result } from 'neverthrow';

import type { SandboxProvider } from './contract.js';
import type { PublicServerUrlError } from './public-server-url.js';

export type RunnerLink =
  | { kind: 'direct'; serverUrl: string }
  /** `secretKey`: what each sandbox's relay secret is derived from. */
  | { kind: 'reverse'; secretKey: Buffer };

export interface RunnerLinkRefusal {
  code: 'no-runner-link';
  message: string;
}

/** Prefer the public URL; otherwise the server dials in, if the provider can publish a port. */
export function chooseRunnerLink(
  publicUrl: Result<string, PublicServerUrlError>,
  provider: Pick<SandboxProvider, 'id' | 'exposePort'>,
  secretKey: () => Buffer,
): Result<RunnerLink, RunnerLinkRefusal> {
  if (publicUrl.isOk()) return ok({ kind: 'direct', serverUrl: publicUrl.value });
  if (provider.exposePort) return ok({ kind: 'reverse', secretKey: secretKey() });
  return err({
    code: 'no-runner-link',
    message: `${publicUrl.error.message} ${provider.id} cannot publish a port for the server to dial in instead.`,
  });
}

/**
 * The per-sandbox secret the relay requires from the server's spares. Derived
 * (not stored) so the server can redial after a restart; bound to the thread
 * and the generation, so a re-provisioned sandbox gets a new one.
 */
export function reverseLinkSecret(key: Buffer, threadId: string, generation: number): string {
  return createHmac('sha256', key)
    .update(`reverse-link:v1:${threadId}:${generation}`)
    .digest('base64url');
}

/** Env the sandbox runner needs for `link`, besides its enrollment credentials. */
export function runnerLinkEnv(
  link: RunnerLink,
  sandbox: { threadId: string; generation: number },
): Record<string, string> {
  if (link.kind === 'direct') return { TEAM_SERVER_URL: link.serverUrl };
  return {
    TEAM_SERVER_URL: `http://127.0.0.1:${REVERSE_LINK_LOOPBACK_PORT}`,
    [REVERSE_LINK_SECRET_ENV]: reverseLinkSecret(
      link.secretKey,
      sandbox.threadId,
      sandbox.generation,
    ),
  };
}
