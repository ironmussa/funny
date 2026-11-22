/** `queue_update`, `compact_boundary`, `context_usage` and `agent:account`. */

import type { ImageAttachment, WSAgentAccountData, WSContextUsageData } from '@funny/shared';

import { applyAgentAccountEvent } from '@/data/agent-account/store';
import {
  applyContextUsageEvent,
  resetContextUsage,
  restoreContextUsage,
} from '@/data/context-usage/store';
import { applyQueueSummary } from '@/data/queue/store';
import { saveAgentAccounts } from '@/lib/agent-account-storage';
import { loadContextUsage, saveContextUsage } from '@/lib/context-usage-storage';

import * as mutations from '../thread-mutations';
import {
  dequeuedUserAlreadyShownInTurn,
  buildDequeuedUserMessage,
  pendingDequeuedMessages,
  trailingAssistantScaffoldStart,
} from './dequeued-messages';
import { isHydrated, maybeBuffer, type Get, type Set } from './shared';

// ── Queue update ─────────────────────────────────────────────────

export function handleWSQueueUpdate(
  get: Get,
  set: Set,
  threadId: string,
  data: {
    threadId: string;
    queuedCount: number;
    nextMessage?: string;
    dequeuedMessage?: string;
    dequeuedImages?: ImageAttachment[];
  },
): void {
  // Buffer dequeued message — will be injected on next agent:message to ensure
  // it appears after the previous agent's response (correct visual ordering).
  // Works for any thread, regardless of which surface holds it.
  const dequeuedMsg = data.dequeuedMessage
    ? {
        content: data.dequeuedMessage,
        images: data.dequeuedImages,
      }
    : null;
  if (dequeuedMsg) {
    pendingDequeuedMessages.set(threadId, dequeuedMsg);
  }

  // The queue lives in the data layer for every thread, loaded or not.
  applyQueueSummary(threadId, data.queuedCount, data.nextMessage);
  if (!dequeuedMsg) return;

  set((state) =>
    mutations.applyThreadDataPatch(state, threadId, (t) => {
      if (dequeuedUserAlreadyShownInTurn(t.messages, dequeuedMsg.content)) {
        pendingDequeuedMessages.delete(threadId);
        return t;
      }
      const insertionIndex = trailingAssistantScaffoldStart(t.messages);
      if (insertionIndex >= t.messages.length) return t;
      pendingDequeuedMessages.delete(threadId);
      const messages = t.messages.slice();
      messages.splice(insertionIndex, 0, buildDequeuedUserMessage(threadId, dequeuedMsg));
      return { ...t, messages };
    }),
  );
}

// ── Compact boundary ────────────────────────────────────────────

export function handleWSCompactBoundary(
  get: Get,
  set: Set,
  threadId: string,
  data: {
    trigger: 'manual' | 'auto';
    preTokens: number;
    postTokens?: number;
    timestamp: string;
  },
): void {
  const state = get();
  if (!isHydrated(state, threadId)) {
    maybeBuffer(state, threadId, 'compact_boundary', data);
    return;
  }
  // Mirror the server-side reset of cumulativeInputTokens (agent-message-handler.ts).
  // Without this the context-usage ring stays frozen at the pre-compaction value
  // until the next agent turn emits a fresh context_usage event. Use the
  // SDK-reported post-compaction size when available so the ring reflects the
  // real reduced context instead of dropping to 0 (which hides the ring).
  saveContextUsage(threadId, resetContextUsage(threadId, data.postTokens ?? 0));
  set((s) =>
    mutations.applyThreadDataPatch(s, threadId, (t) => ({
      ...t,
      compactionEvents: [...(t.compactionEvents ?? []), data],
    })),
  );
}

// ── Context usage ───────────────────────────────────────────────

export function handleWSContextUsage(threadId: string, data: WSContextUsageData): void {
  // A running thread's per-message events (no breakdown) can arrive in a fresh
  // tab before the thread is selected. Restore the saved snapshot first, or the
  // event creates a row without the breakdown, selecting the thread no longer
  // restores, and the save below overwrites the stored breakdown.
  restoreContextUsage(threadId, () => loadContextUsage(threadId));
  // Persist across page reloads — the runtime only keeps usage in memory.
  saveContextUsage(threadId, applyContextUsageEvent(threadId, data));
}

// ── Agent account ──────────────────────────────────────────────

export function handleWSAgentAccount(threadId: string, data: WSAgentAccountData): void {
  // Persist across page reloads — the runtime only reports it while running.
  saveAgentAccounts(applyAgentAccountEvent(threadId, data));
}
