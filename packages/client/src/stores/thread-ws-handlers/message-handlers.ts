/** `agent:init`, `agent:message`, `agent:tool_call` and `agent:tool_output`. */

import type { MessageRole } from '@funny/shared';

import { parseToolInput, useThreadActiveToolStore } from '../thread-active-tool-store';
import { invalidateThreadData } from '../thread-machine-bridge';
import * as mutations from '../thread-mutations';
import type { AgentInitInfo } from '../thread-types';
import { takeDequeuedUserMessages } from './dequeued-messages';
import {
  findTailUserMessageWithContent,
  isHydrated,
  maybeBuffer,
  patchSidebarLastAssistant,
  wsLog,
  type Get,
  type Set,
} from './shared';

// ── Init ────────────────────────────────────────────────────────

export function handleWSInit(get: Get, set: Set, threadId: string, data: AgentInitInfo): void {
  set((state) =>
    mutations.applyThreadDataPatch(state, threadId, (t) => ({
      ...t,
      initInfo: data,
    })),
  );
}

// ── Message ─────────────────────────────────────────────────────

/** A message row for a live `agent:message`, dated now unless the event says otherwise. */
function newWSMessage(threadId: string, data: WSMessageData) {
  return {
    id: data.messageId || crypto.randomUUID(),
    threadId,
    // SAFETY: WSMessageData types `role` as string, but every agent:message emitter (runtime
    // ingest-mapper / agent-message-handler, server sandbox wiring) sends 'user', 'assistant' or 'system'.
    role: data.role as MessageRole,
    content: data.content,
    timestamp: data.timestamp ?? new Date().toISOString(),
    author: data.author || undefined,
  };
}

interface WSMessageData {
  messageId?: string;
  role: string;
  content: string;
  author?: string;
  /** Set when the message is dated earlier than now (a sandbox retry's initial prompt). */
  timestamp?: string;
}

export function handleWSMessage(get: Get, set: Set, threadId: string, data: WSMessageData): void {
  const state = get();
  const hydrated = isHydrated(state, threadId);

  wsLog.debug('handleWSMessage applying', {
    threadId,
    messageId: data?.messageId ?? '',
    role: data?.role ?? '',
    contentChars: String(data?.content?.length ?? 0),
    selectedMatch: String(state.selectedThreadId === threadId),
    hydrated: String(hydrated),
  });

  // Drop the cached snapshot so the next selectThread() refetches. Must run
  // even for the active thread — otherwise switching away and back resolves
  // from the pre-event cache and the new message is invisible.
  invalidateThreadData(threadId);

  if (!hydrated) {
    if (maybeBuffer(state, threadId, 'message', data)) return;
    // Not hydrated and not selected — still update the sidebar snippet so
    // the row shows the latest assistant message.
    if (data.role === 'assistant' && data.content) {
      patchSidebarLastAssistant(threadId, data.content);
    }
    return;
  }

  // Apply the message to the loaded payload — works whether the thread is
  // in the right pane, a live column, or both.
  set((s) =>
    mutations.applyThreadDataPatch(s, threadId, (t) => {
      const messageId = data.messageId;

      if (messageId) {
        const existingIdx = t.messages.findIndex((m) => m.id === messageId);
        if (existingIdx >= 0) {
          const updated = [...t.messages];
          const extraMessages =
            data.role === 'assistant'
              ? takeDequeuedUserMessages(threadId, t.messages, existingIdx)
              : [];
          updated[existingIdx] = {
            ...updated[existingIdx],
            content: data.content,
            author: data.author || undefined,
          };
          if (extraMessages.length) updated.splice(existingIdx, 0, ...extraMessages);
          return {
            ...t,
            lastUserMessage: extraMessages.at(-1) ?? t.lastUserMessage,
            messages: updated,
          };
        }
      }

      // If there's a buffered dequeued user message AND the current event is
      // an assistant message, prepend the user message so it appears in the
      // correct position. Skip injection when:
      //   - the incoming message is itself the user message (would double it)
      //   - the payload already shows the same user message immediately before
      //     the insertion point (server-loaded duplicate, e.g. after a thread
      //     refresh; bug 4 — visual duplicate of the dequeued message)
      // Inject the buffered dequeued user card before the agent's first output
      // of the turn. handleWSToolCall does the same — whichever lands first
      // wins (queued turns often start with a tool call, not assistant text).
      const extraMessages =
        data.role === 'assistant' ? takeDequeuedUserMessages(threadId, t.messages) : [];

      const newMsg = newWSMessage(threadId, data);

      if (data.role === 'user') {
        const optimisticIdx = findTailUserMessageWithContent(t.messages, data.content);
        if (optimisticIdx >= 0) {
          const updated = [...t.messages];
          updated[optimisticIdx] = { ...updated[optimisticIdx], ...newMsg };
          return {
            ...t,
            lastUserMessage: updated[optimisticIdx],
            messages: updated,
          };
        }
      }

      const lastUserMessage =
        extraMessages.length > 0
          ? extraMessages[extraMessages.length - 1]
          : data.role === 'user'
            ? newMsg
            : t.lastUserMessage;

      return {
        ...t,
        lastUserMessage,
        messages: [...t.messages, ...extraMessages, newMsg],
      };
    }),
  );

  // Sidebar snippet for assistant messages (independent of payload patch).
  if (data.role === 'assistant' && data.content) {
    patchSidebarLastAssistant(threadId, data.content);
  }
}

// ── Tool Call ───────────────────────────────────────────────────

export function handleWSToolCall(
  get: Get,
  set: Set,
  threadId: string,
  data: {
    toolCallId?: string;
    messageId?: string;
    name: string;
    input: unknown;
    author?: string;
    parentToolCallId?: string;
  },
): void {
  const state = get();

  // Sidebar snippet: what the agent is doing right now.
  useThreadActiveToolStore
    .getState()
    .setActive(threadId, { name: data.name, input: parseToolInput(data) });

  // Drop the cached snapshot so the next selectThread() refetches and includes
  // this tool call. Runs unconditionally so the active thread's cache stays in
  // sync with the live payload.
  invalidateThreadData(threadId);

  if (!isHydrated(state, threadId)) {
    maybeBuffer(state, threadId, 'tool_call', data);
    return;
  }

  set((s) =>
    mutations.applyThreadDataPatch(s, threadId, (t) => {
      const toolCallId = data.toolCallId || crypto.randomUUID();
      const tcEntry = {
        id: toolCallId,
        messageId: data.messageId || '',
        name: data.name,
        input: JSON.stringify(data.input),
        timestamp: new Date().toISOString(),
        author: data.author || undefined,
        parentToolCallId: data.parentToolCallId || undefined,
      };

      // De-dup against any existing entry — WS retries can land twice.
      if (t.messages.some((m) => m.toolCalls?.some((tc: any) => tc.id === toolCallId))) {
        return t;
      }

      // A queued follow-up often starts its turn with a tool call. Inject the
      // buffered dequeued user card now — before this tool call's message — so
      // it doesn't stay invisible until the first assistant text lands. Placed
      // after the de-dup guard so a retried tool call can't consume the buffer.
      const extra = takeDequeuedUserMessages(threadId, t.messages);
      const userPatch = extra.length ? { lastUserMessage: extra[extra.length - 1] } : null;

      if (data.messageId) {
        const msgIdx = t.messages.findIndex((m) => m.id === data.messageId);
        if (msgIdx >= 0) {
          const messages = t.messages.slice();
          const msg = messages[msgIdx];
          messages[msgIdx] = {
            ...msg,
            toolCalls: (msg.toolCalls ?? []).concat(tcEntry),
          };
          if (extra.length) messages.splice(msgIdx, 0, ...extra);
          return { ...t, ...userPatch, messages };
        }
      }

      return {
        ...t,
        ...userPatch,
        messages: [
          ...t.messages,
          ...extra,
          {
            id: data.messageId || crypto.randomUUID(),
            threadId,
            role: 'assistant',
            content: '',
            timestamp: new Date().toISOString(),
            toolCalls: [tcEntry],
          },
        ],
      };
    }),
  );
}

// ── Tool Output ─────────────────────────────────────────────────

export function handleWSToolOutput(
  get: Get,
  set: Set,
  threadId: string,
  data: { toolCallId: string; output: string },
): void {
  // Cached snapshot would still hold the tool call without its output —
  // invalidate unconditionally so switching away and back doesn't show the
  // stale pre-output state.
  invalidateThreadData(threadId);

  const state = get();
  if (!isHydrated(state, threadId)) {
    maybeBuffer(state, threadId, 'tool_output', data);
    return;
  }

  set((s) =>
    mutations.applyThreadDataPatch(s, threadId, (t) => {
      // Find and update only the specific message containing the tool call.
      for (let i = 0; i < t.messages.length; i++) {
        const msg = t.messages[i];
        if (!msg.toolCalls) continue;
        const tcIdx = msg.toolCalls.findIndex((tc: any) => tc.id === data.toolCallId);
        if (tcIdx < 0) continue;
        const messages = t.messages.slice();
        const updatedTCs = [...msg.toolCalls];
        updatedTCs[tcIdx] = { ...updatedTCs[tcIdx], output: data.output };
        messages[i] = { ...msg, toolCalls: updatedTCs };
        return { ...t, messages };
      }
      return t;
    }),
  );
}
