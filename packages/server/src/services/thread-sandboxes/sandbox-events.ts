/**
 * Sandbox failures as cards in the thread (change thread-sandboxes).
 *
 * Any provider / sandbox failure a user can act on is posted as a persisted
 * `sandbox:error` thread event — it stays in the conversation's history — and
 * broadcast live with the same envelope as other thread events. Each event
 * carries the provider's own message plus a hint derived from the normalized
 * error kind, so the user knows what to do next.
 */

import { log } from '../../lib/logger.js';
import { saveThreadEvent } from '../thread-event-repository.js';
import type { SandboxError } from './contract.js';
import type { ProvisionError } from './thread-sandbox-service.js';

export const SANDBOX_ERROR_EVENT = 'sandbox:error';

/** When the failure happened, from the user's point of view. */
export type SandboxErrorPhase = 'setup' | 'start' | 'wake';

export interface SandboxErrorEventData {
  phase: SandboxErrorPhase;
  message: string;
  /** Normalized error kind (`quota`, `auth`, …), when known. */
  kind?: string;
  /** What the user can do about it. */
  hint?: string;
}

const HINTS: Partial<Record<SandboxError['kind'] | ProvisionError['kind'], string>> = {
  quota:
    "The sandbox provider's plan limit was reached. Delete a sandbox thread you no longer need, wait for idle sandboxes to stop, or upgrade the provider plan.",
  auth: 'The sandbox provider rejected the credential. Update it in Preferences > Sandboxes.',
  connection: 'The sandbox connection is missing or invalid. Check it in Preferences > Sandboxes.',
  expired: "The sandbox's disk expired. Start a new sandbox thread.",
  'not-found': 'The sandbox no longer exists at the provider. Start a new sandbox thread.',
  'rate-limited': 'The sandbox provider is rate limiting requests. Try again in a minute.',
  unavailable: 'The sandbox provider is temporarily unavailable. Try again in a few minutes.',
  checkout:
    'The project could not be cloned in the sandbox. Check that the repository is reachable with your GitHub token (Preferences > GitHub).',
};

/** The event payload for a provisioning / wake failure. */
export function sandboxErrorEventData(
  phase: SandboxErrorPhase,
  error: ProvisionError | string,
): SandboxErrorEventData {
  if (typeof error === 'string') return { phase, message: error };
  const kind = error.kind === 'sandbox' ? error.cause : error.kind;
  const hint = HINTS[kind];
  return { phase, message: error.message, kind, ...(hint ? { hint } : {}) };
}

interface BrowserEventsPort {
  toUser(userId: string, event: Record<string, unknown>): void;
}

/** Persist the card in the thread and show it live. Never throws. */
export async function postSandboxError(
  input: { threadId: string; userId: string; data: SandboxErrorEventData },
  browserEvents: BrowserEventsPort | undefined,
): Promise<void> {
  const { threadId, userId, data } = input;
  const id = crypto.randomUUID();
  try {
    await saveThreadEvent(threadId, SANDBOX_ERROR_EVENT, { ...data }, id);
    browserEvents?.toUser(userId, {
      type: 'thread:event',
      threadId,
      data: {
        event: {
          id,
          threadId,
          type: SANDBOX_ERROR_EVENT,
          data: JSON.stringify(data),
          createdAt: new Date().toISOString(),
        },
      },
    });
  } catch (error) {
    log.error('Failed to post sandbox error to the thread', {
      namespace: 'thread-sandboxes',
      threadId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
