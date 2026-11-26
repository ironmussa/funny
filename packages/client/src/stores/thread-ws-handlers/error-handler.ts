/** `agent:error`, with network failures reworded for the toast. */

import { toast } from '@/components/ui/toast';
import i18n from '@/i18n/config';

import * as mutations from '../thread-mutations';
import type { Get, Set } from './shared';
import { handleWSStatus } from './status-handlers';

// ── Error ────────────────────────────────────────────────────────

/**
 * Handle agent:error WS events. Unlike handleWSStatus (which only sets
 * status to 'failed'), this stores the error message in resultInfo so
 * AgentResultCard can display it, and shows a toast immediately.
 */
export function handleWSError(
  get: Get,
  set: Set,
  threadId: string,
  data: { error?: string },
): void {
  const errorMessage = data.error ?? 'Unknown error';

  // Delegate status transition to the existing handler (updates sidebar + payload)
  handleWSStatus(get, set, threadId, { status: 'failed' });

  // Now enrich the payload with resultInfo so AgentResultCard renders the error.
  // Works for any hydrated thread (right pane or live column).
  set((state) =>
    mutations.applyThreadDataPatch(state, threadId, (t) =>
      t.resultInfo
        ? t
        : {
            ...t,
            resultInfo: {
              status: 'failed' as const,
              cost: t.cost ?? 0,
              duration: 0,
              error: errorMessage,
            },
          },
    ),
  );

  // Show an immediate toast with a user-friendly error
  toast.error(friendlyAgentError(errorMessage), { duration: 8000 });
}

// ── Network-error humanizer ─────────────────────────────────────

/**
 * Network-level error codes/messages that indicate connectivity issues.
 * Maps raw error substrings to i18n keys under `errors.agentNetwork.*`.
 */
const NETWORK_ERROR_PATTERNS: [test: RegExp, i18nKey: string][] = [
  [/EAI_AGAIN/i, 'errors.agentNetwork.dnsFailure'],
  [/ENOTFOUND/i, 'errors.agentNetwork.dnsFailure'],
  [/ENETUNREACH/i, 'errors.agentNetwork.noInternet'],
  [/ECONNREFUSED/i, 'errors.agentNetwork.connectionRefused'],
  [/ECONNRESET/i, 'errors.agentNetwork.connectionReset'],
  [/ETIMEDOUT/i, 'errors.agentNetwork.timeout'],
  [/fetch failed/i, 'errors.agentNetwork.fetchFailed'],
  [/network\s*(error|failure)/i, 'errors.agentNetwork.generic'],
];

function friendlyAgentError(raw: string): string {
  for (const [pattern, key] of NETWORK_ERROR_PATTERNS) {
    if (pattern.test(raw)) {
      return i18n.t(key, {
        defaultValue: 'Connection lost. Please check your internet connection and try again.',
      });
    }
  }
  return raw;
}
