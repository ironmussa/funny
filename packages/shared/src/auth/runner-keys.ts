/**
 * Per-runner keys (security H1).
 *
 * The deployment-wide `RUNNER_AUTH_SECRET` is the server's ROOT secret. It is
 * never handed to a self-enrolled runner. Instead every runner gets its own
 * forwarding key, derived deterministically from the root secret and the
 * runner's id:
 *
 *   K_r     = HMAC-SHA256(RUNNER_AUTH_SECRET, "funny-runner-forward:v1:" + runnerId)
 *   K_media = HMAC-SHA256(K_r, "funny-runner-media:v1")
 *
 * - The server signs forwarded identity (`X-Forwarded-Signature`) and sends
 *   `X-Runner-Auth` to runner `r` with `K_r`, and signs direct-media URLs for
 *   `r` with `K_media(r)`.
 * - Runner `r` verifies with its own `K_r` / `K_media`. A device-link enrolled
 *   runner receives `K_r` at enrollment; an operator-provisioned runner (which
 *   already holds the root secret) derives `K_r` itself once it learns its id.
 *
 * Because HMAC is one-way, holding `K_r` gives no way to compute `K_s` for
 * another runner `s`, nor the root secret. So a compromised runner can at most
 * forge requests against ITSELF, and its key never matches the server's
 * `X-Runner-Auth` root-secret check (which grants `isRunner` on the server).
 */

import { createHmac } from 'crypto';

const FORWARD_LABEL = 'funny-runner-forward:v1:';
const MEDIA_LABEL = 'funny-runner-media:v1';

/** Derive runner `runnerId`'s forwarding key from the deployment root secret. */
export function deriveRunnerForwardingKey(rootSecret: string, runnerId: string): string {
  if (!rootSecret) throw new Error('deriveRunnerForwardingKey: root secret is empty');
  if (!runnerId) throw new Error('deriveRunnerForwardingKey: runnerId is empty');
  return createHmac('sha256', rootSecret)
    .update(FORWARD_LABEL + runnerId)
    .digest('hex');
}

/** Derive the direct-media URL signing key from a runner's forwarding key. */
export function deriveRunnerMediaKey(forwardingKey: string): string {
  if (!forwardingKey) throw new Error('deriveRunnerMediaKey: forwarding key is empty');
  return createHmac('sha256', forwardingKey).update(MEDIA_LABEL).digest('hex');
}
