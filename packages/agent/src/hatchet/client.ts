/**
 * Hatchet client singleton.
 *
 * Initializes lazily on first call to getHatchetClient().
 * Reads HATCHET_CLIENT_TOKEN from the environment.
 * If the token is not set, Hatchet features are disabled gracefully.
 */

import { HatchetClient } from '@hatchet-dev/typescript-sdk/v1';

let client: HatchetClient | null = null;

/**
 * Get the Hatchet client (lazy singleton).
 * Requires HATCHET_CLIENT_TOKEN to be set in the environment.
 */
export function getHatchetClient(): HatchetClient {
  if (!client) {
    client = HatchetClient.init();
  }
  return client;
}

/**
 * Check if Hatchet is enabled (token is configured).
 */
export function isHatchetEnabled(): boolean {
  return !!process.env.HATCHET_CLIENT_TOKEN;
}
