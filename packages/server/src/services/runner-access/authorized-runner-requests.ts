/**
 * The authorized server → runner sinks. Every request or terminal message the
 * server sends to a runner goes through here with a `RunnerFor` proof about
 * the exact actor and runner it is for.
 *
 * The sink SIGNS the identity itself, from the named actor the proof is
 * about, with a fresh nonce immediately before the physical send. Any
 * identity header the caller supplied is dropped first, so a spoofed
 * `X-Forwarded-*` header can never reach a runner. The wire format is the
 * one `@funny/shared/auth/forwarded-identity` defines; the runtime verifies it
 * exactly as before.
 */

import {
  NONCE_HEADER,
  ON_BEHALF_OF_THREAD_HEADER,
  SHARE_LEVEL_HEADER,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  signForwardedIdentity,
  type ForwardedIdentity,
} from '@funny/shared/auth/forwarded-identity';
import type { Named } from '@gdp-ts/core';

import type {
  RunnerRequestPort,
  RunnerResponse,
  RunnerTerminalEvent,
  RunnerTerminalPort,
} from '../runner-ports.js';
import type { RunnerActor, RunnerId } from './runner-actor.js';
import type { OAuthCallbackRunner, RunnerFor } from './runner-for.js';

/** A runner request without identity. Identity headers in `headers` are ignored. */
export interface UnsignedRunnerRequest {
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array | null;
  signal?: AbortSignal;
  deadlineAt?: number;
}

/** Exactly the headers `signForwardedIdentity` produces, plus the shared secret. */
const IDENTITY_HEADERS = new Set(
  [
    'X-Forwarded-User',
    'X-Forwarded-Role',
    'X-Forwarded-Org',
    'X-Forwarded-Org-Name',
    'X-Runner-Auth',
    SIGNATURE_HEADER,
    TIMESTAMP_HEADER,
    NONCE_HEADER,
    SHARE_LEVEL_HEADER,
    ON_BEHALF_OF_THREAD_HEADER,
  ].map((h) => h.toLowerCase()),
);

/** Drop every caller-supplied identity header (case-insensitively). */
export function stripIdentityHeaders(headers: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!IDENTITY_HEADERS.has(key.toLowerCase())) out[key] = value;
  }
  return out;
}

// Read at call time: tests set it per file, and the server may import this
// module before the environment is final.
function runnerAuthSecret(): string {
  const secret = process.env.RUNNER_AUTH_SECRET;
  if (!secret) throw new Error('RUNNER_AUTH_SECRET is not set');
  return secret;
}

function identityOf(actor: RunnerActor): ForwardedIdentity {
  return { userId: actor.userId, role: actor.role, orgId: actor.orgId, orgName: actor.orgName };
}

/** Identity headers for `identity`, signed with a fresh nonce. */
function signedIdentityHeaders(identity: ForwardedIdentity): Record<string, string> {
  const secret = runnerAuthSecret();
  const headers: Record<string, string> = {
    'X-Runner-Auth': secret,
    'X-Forwarded-User': identity.userId,
    'X-Forwarded-Role': identity.role ?? 'user',
  };
  if (identity.orgId) headers['X-Forwarded-Org'] = identity.orgId;
  if (identity.orgName) headers['X-Forwarded-Org-Name'] = identity.orgName;
  if (identity.shareLevel) headers[SHARE_LEVEL_HEADER] = identity.shareLevel;
  if (identity.onBehalfOfThread) headers[ON_BEHALF_OF_THREAD_HEADER] = identity.onBehalfOfThread;
  const { signature, timestamp, nonce } = signForwardedIdentity(identity, secret);
  headers[SIGNATURE_HEADER] = signature;
  headers[TIMESTAMP_HEADER] = String(timestamp);
  headers[NONCE_HEADER] = nonce;
  return headers;
}

/** Wraps the raw request transport; only reachable with a proof. */
export class AuthorizedRunnerRequests {
  constructor(private readonly port: RunnerRequestPort | undefined) {}

  isAvailable<R>(runner: Named<R, RunnerId>): boolean {
    return !!this.port?.isAvailable(runner.value);
  }

  /** Send as `actor` to `runner`. The proof binds the two. */
  send<A, R>(
    actor: Named<A, RunnerActor>,
    runner: Named<R, RunnerId>,
    _proof: RunnerFor<A, R>,
    request: UnsignedRunnerRequest,
  ): Promise<RunnerResponse> {
    return this.dispatch(runner.value, request, signedIdentityHeaders(identityOf(actor.value)));
  }

  /**
   * Steer-share delegation (thread-sharing-steer): send to the OWNER's runner
   * (the proof is about the owner) while signing the SHAREE with a `steer`
   * claim for the thread. Allowed only from `middleware/proxy.ts`, after
   * `requireThreadSteer` has authorized the sharee.
   */
  sendDelegated<A, R>(
    owner: Named<A, RunnerActor>,
    runner: Named<R, RunnerId>,
    _proof: RunnerFor<A, R>,
    delegation: { readonly sharee: RunnerActor; readonly threadId: string },
    request: UnsignedRunnerRequest,
  ): Promise<RunnerResponse> {
    if (delegation.sharee.userId === owner.value.userId) {
      throw new Error('steer delegation requires a sharee other than the owner');
    }
    return this.dispatch(
      runner.value,
      request,
      signedIdentityHeaders({
        ...identityOf(delegation.sharee),
        shareLevel: 'steer',
        onBehalfOfThread: delegation.threadId,
      }),
    );
  }

  /** The unauthenticated MCP OAuth callback: shared secret, no identity. */
  sendOAuthCallback<R>(
    runner: Named<R, RunnerId>,
    _proof: OAuthCallbackRunner<R>,
    request: UnsignedRunnerRequest,
  ): Promise<RunnerResponse> {
    return this.dispatch(runner.value, request, { 'X-Runner-Auth': runnerAuthSecret() });
  }

  private dispatch(
    runnerId: string,
    request: UnsignedRunnerRequest,
    identity: Record<string, string>,
  ): Promise<RunnerResponse> {
    if (!this.port) throw new Error('Runner request transport is not available');
    return this.port.request(runnerId, {
      method: request.method,
      path: request.path,
      headers: { ...stripIdentityHeaders(request.headers), ...identity },
      body: request.body ?? null,
      signal: request.signal,
      deadlineAt: request.deadlineAt,
    });
  }
}

/** Wraps the raw terminal transport; only reachable with a proof. */
export class AuthorizedRunnerTerminal {
  constructor(private readonly port: RunnerTerminalPort | undefined) {}

  isAvailable<R>(runner: Named<R, RunnerId>): boolean {
    return !!this.port?.isAvailable(runner.value);
  }

  dispatch<A, R>(
    actor: Named<A, RunnerActor>,
    runner: Named<R, RunnerId>,
    _proof: RunnerFor<A, R>,
    event: RunnerTerminalEvent,
  ): void {
    if (!this.port) throw new Error('Runner terminal transport is not available');
    this.port.dispatch(runner.value, actor.value.userId, event);
  }

  listSessions<A, R>(
    actor: Named<A, RunnerActor>,
    runner: Named<R, RunnerId>,
    _proof: RunnerFor<A, R>,
  ): Array<Record<string, unknown>> {
    if (!this.port) throw new Error('Runner terminal transport is not available');
    return this.port.listSessions(runner.value, actor.value.userId);
  }
}

export const authorizedRunnerRequests = (port: RunnerRequestPort | undefined) =>
  new AuthorizedRunnerRequests(port);

export const authorizedRunnerTerminal = (port: RunnerTerminalPort | undefined) =>
  new AuthorizedRunnerTerminal(port);
