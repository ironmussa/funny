/**
 * The runner's own credentials for authenticating the SERVER (security H1/H7).
 *
 * Held in module state — deliberately NOT in `process.env`, so agent / PTY /
 * command children can never inherit them (security M8).
 *
 * - `forwardingKey` (`K_r`): verifies `X-Runner-Auth` + the forwarded-identity
 *   HMAC on proxied requests. Either delivered by the server (device-link
 *   enrollment / registration) or derived locally from the operator-supplied
 *   root `RUNNER_AUTH_SECRET` once the runner knows its id. See
 *   `@funny/shared/auth/runner-keys`.
 * - `mediaKey`: verifies `/api/files/raw-signed` URLs; derived from `K_r`.
 * - `ownerUserId`: the only user allowed to authenticate directly with a
 *   session cookie (H7). Unknown ⇒ cookie auth is refused.
 *
 * Until the runner has registered (no runner id ⇒ no key) every forwarded
 * request fails closed.
 */

import { deriveRunnerForwardingKey, deriveRunnerMediaKey } from '@funny/shared/auth/runner-keys';

interface RunnerKeyState {
  runnerId: string | null;
  forwardingKey: string | null;
  mediaKey: string | null;
  ownerUserId: string | null;
}

const state: RunnerKeyState = {
  runnerId: null,
  forwardingKey: null,
  mediaKey: null,
  ownerUserId: null,
};

export interface RunnerKeyInput {
  runnerId: string;
  /** Operator-provisioned deployment root secret, if this runner has one. */
  rootSecret?: string | null;
  /** Per-runner key delivered by the server (enrollment / registration). */
  forwardingKey?: string | null;
  ownerUserId?: string | null;
}

/**
 * Resolve this runner's forwarding key. A key the server delivered (it is
 * derived from the server's CURRENT root secret) wins; otherwise an
 * operator-provisioned runner derives it from its own root secret (older
 * servers that don't return a key). Returns null when neither exists.
 *
 * Server-delivered first matters when the local root secret is stale: the
 * server then rejects it, the runner falls back to device-link enrollment, and
 * the freshly delivered key must be used rather than one derived from the
 * stale secret.
 */
export function resolveRunnerForwardingKey(input: RunnerKeyInput): string | null {
  if (input.forwardingKey) return input.forwardingKey;
  if (input.rootSecret) return deriveRunnerForwardingKey(input.rootSecret, input.runnerId);
  return null;
}

/** Install the runner's identity + keys after registration / resume / enrollment. */
export function configureRunnerKeys(input: RunnerKeyInput): void {
  const forwardingKey = resolveRunnerForwardingKey(input);
  state.runnerId = input.runnerId;
  state.forwardingKey = forwardingKey;
  state.mediaKey = forwardingKey ? deriveRunnerMediaKey(forwardingKey) : null;
  state.ownerUserId = input.ownerUserId || null;
}

/** The key the server signs this runner's forwarded identity with, or null. */
export function getRunnerForwardingKey(): string | null {
  return state.forwardingKey;
}

/** The key the server signs this runner's direct-media URLs with, or null. */
export function getRunnerMediaKey(): string | null {
  return state.mediaKey;
}

/** The user that owns this runner, or null when not (yet) known. */
export function getRunnerOwnerUserId(): string | null {
  return state.ownerUserId;
}

/** Forget all keys (runner-mode shutdown, tests). */
export function clearRunnerKeys(): void {
  state.runnerId = null;
  state.forwardingKey = null;
  state.mediaKey = null;
  state.ownerUserId = null;
}
