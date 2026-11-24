/**
 * `selectThread`: switch the open thread, load its payload and replay the
 * WebSocket events that arrived while it was loading.
 */

import { startTransition } from 'react';

import { restoreAgentAccounts } from '@/data/agent-account/store';
import { restoreContextUsage } from '@/data/context-usage/store';
import { seedQueueSummary } from '@/data/queue/store';
import { newestActivity } from '@/data/thread-recap/activity';
import { adoptThreadDetail } from '@/data/threads/loaders';
import { isProjectListed } from '@/data/threads/read';
import { loadAgentAccounts } from '@/lib/agent-account-storage';
import { createClientLogger, isClientLogLevelEnabled } from '@/lib/client-logger';
import { loadContextUsage } from '@/lib/context-usage-storage';
import { markMemoryPhase } from '@/lib/memory-phase';
import { metric, startSpan } from '@/lib/telemetry';

import { settlePreSendStateFromFetch } from './optimistic-run-state';
import { expandProject, selectProject as bridgeSelectProject } from './store-bridge';
import { evictIfUnreferenced } from './thread-live-refs';
import {
  isThreadDataLoaded,
  isThreadDataPrefetched,
  loadThreadData,
} from './thread-machine-bridge';
import * as mutations from './thread-mutations';
import { recordThreadOpened, useThreadReadStore } from './thread-read-store';
import {
  computeNextActiveThread,
  deriveResultInfo,
  deriveWaitingState,
  reconstructCompactionEvents,
} from './thread-select-helpers';
import type { ThreadState } from './thread-state';
import {
  clearWSBuffer,
  getAndClearWSBuffer,
  getBufferedInitInfo,
  getSelectGeneration,
  getSelectingThreadId,
  nextSelectGeneration,
  notifyThreadSelected,
  setSelectingThreadId,
} from './thread-store-internals';
import type { ThreadWithMessages } from './thread-types';
import type { Get, Set } from './thread-ws-handlers/shared';

const SELECT_LOG_NS = 'thread-select';
const selectLog = createClientLogger(SELECT_LOG_NS);

type ThreadSnapshot = Awaited<ReturnType<typeof loadThreadData>>;

// ── Buffer replay ────────────────────────────────────────────────

function flushWSBuffer(threadId: string, store: ThreadState) {
  const events = getAndClearWSBuffer(threadId);
  if (!events) return;
  for (const event of events) {
    switch (event.type) {
      case 'message':
        store.handleWSMessage(threadId, event.data);
        break;
      case 'tool_call':
        store.handleWSToolCall(threadId, event.data);
        break;
      case 'tool_output':
        store.handleWSToolOutput(threadId, event.data);
        break;
      case 'status':
        store.handleWSStatus(threadId, event.data);
        break;
      case 'error':
        store.handleWSError(threadId, event.data);
        break;
      case 'result':
        store.handleWSResult(threadId, event.data);
        break;
      case 'compact_boundary':
        store.handleWSCompactBoundary(threadId, event.data);
        break;
    }
  }
}

/**
 * Diagnostic: who is driving selection? Surfaces the caller chain behind the
 * route-sync ↔ back-fill re-select ping-pong. Off in prod by default; enable
 * with `__funnyLog.setNamespaceLevel('thread-select', 'debug')`.
 *
 * The stack is built only when the level is on: `selectThread` runs on every
 * route sync, and capturing a stack costs far more than the call itself.
 */
function traceSelectCaller(threadId: string, state: ThreadState): void {
  if (!isClientLogLevelEnabled(SELECT_LOG_NS, 'debug')) return;
  // Frames 0-3 are `Error`, this function, `selectThreadFlow` and the
  // `selectThread` store action: start at the caller.
  const caller = new Error().stack?.split('\n').slice(4, 9).join(' <- ').replace(/\s+/g, ' ');
  selectLog.debug('selectThread called', {
    threadId,
    prevSelectedId: state.selectedThreadId ?? null,
    prevActiveId: state.activeThread?.id ?? null,
    caller,
  });
}

/** What the urgent half of a switch decided, for the load that follows it. */
interface SwitchContext {
  threadId: string;
  gen: number;
  startMs: number;
  prevSelectedId: string | null;
  prevActive: ThreadWithMessages | null;
  keepStale: boolean;
}

/** Load the thread's payload; on a failure that this selection still owns, record it. */
async function loadSelectedThread(
  set: Set,
  get: Get,
  ctx: SwitchContext,
): Promise<ThreadSnapshot | null> {
  const { threadId, gen, startMs } = ctx;
  const fromCache = isThreadDataPrefetched(threadId);
  let snapshot: ThreadSnapshot;
  try {
    snapshot = await loadThreadData(threadId);
  } catch (error) {
    metric('thread.select.network_ms', Date.now() - startMs, {
      attributes: { 'thread.from_cache': fromCache ? '1' : '0' },
    });
    if (getSelectGeneration() === gen) {
      selectLog.warn('thread load failed', {
        threadId,
        error: error instanceof Error ? error.message : String(error),
      });
      clearWSBuffer(threadId);
      // Record the failure: the URL still names this thread, so without it
      // the view would wait on a payload that is never coming.
      set({ selectedThreadId: null, activeThread: null, threadLoadFailedId: threadId });
      // Drop any half-populated entry too so a retry starts clean.
      evictIfUnreferenced(get, set, threadId);
    }
    return null;
  }
  metric('thread.select.network_ms', Date.now() - startMs, {
    attributes: { 'thread.from_cache': fromCache ? '1' : '0' },
  });
  return snapshot;
}

type LoadedThread = Omit<ThreadSnapshot['thread'], 'queuedCount' | 'queuedNextMessage'>;

/** Pagination metadata of the loaded message window, with its defaults. */
function messageWindow(thread: LoadedThread) {
  return {
    hasMore: thread.hasMore ?? false,
    hasMoreAfter: thread.hasMoreAfter ?? false,
    totalMessages: thread.total ?? thread.messages?.length ?? 0,
    windowStart: thread.windowStart ?? 0,
  };
}

/** The loaded payload with the derived fields the view needs on first paint. */
function hydrateThread(
  get: Get,
  threadId: string,
  thread: LoadedThread,
  threadEvents: ThreadSnapshot['events'],
): ThreadWithMessages {
  const buffered = getBufferedInitInfo(threadId);
  const resultInfo = deriveResultInfo(thread);

  // Derive waitingReason and pendingPermission from the last tool call when reloading a waiting thread
  const { waitingReason, pendingPermission } = deriveWaitingState(thread);

  // Reconstruct compactionEvents from persisted thread events so they survive refreshes
  const compactionEvents = reconstructCompactionEvents(threadEvents);

  // Merge stored setup progress for setting_up threads
  const storedSetupProgress =
    thread.status === 'setting_up' ? get().setupProgressByThread[threadId] : undefined;

  return {
    ...thread,
    ...messageWindow(thread),
    leadingUserMessage: thread.leadingUserMessage,
    threadEvents,
    initInfo: thread.initInfo || buffered || undefined,
    resultInfo,
    waitingReason,
    pendingPermission,
    setupProgress: storedSetupProgress,
    compactionEvents: compactionEvents.length > 0 ? compactionEvents : undefined,
  };
}

/** After the payload is published: drop the stale one, select the project, mark the thread read. */
function settleOpenedThread(set: Set, get: Get, ctx: SwitchContext, thread: LoadedThread): void {
  const { threadId, prevSelectedId, keepStale } = ctx;
  // Deferred eviction for the `keepStale` path: we skipped it above so the
  // back-fill subscriber wouldn't see `activeThread` pointing at an entry
  // missing from `threadDataById`. Now that `setThreadData` has repointed
  // `activeThread` at the new thread, it's safe to drop the old payload.
  if (keepStale && prevSelectedId && prevSelectedId !== threadId) {
    evictIfUnreferenced(get, set, prevSelectedId);
  }

  bridgeSelectProject(thread.projectId);

  // Before the open marks it read: the recap card's `since` is the read
  // marker as the owner left it (openspec thread-recap).
  recordThreadOpened(threadId, {
    createdAt: thread.createdAt,
    ...newestActivity(thread.messages, thread.hasMoreAfter),
  });

  // Mark the thread as read so the unread blue dot in the sidebar clears.
  if (thread.completedAt) {
    useThreadReadStore.getState().markRead(threadId, thread.completedAt);
  }
}

/**
 * Publish a loaded payload, if this selection still owns the switch. Returns
 * false when a newer selection took over.
 */
function applyLoadedThread(
  set: Set,
  get: Get,
  ctx: SwitchContext,
  snapshot: ThreadSnapshot,
): boolean {
  const { threadId, gen, prevActive } = ctx;
  // The queue summary lives in the data layer (`data/queue`), not in the payload.
  const { queuedCount, queuedNextMessage, ...thread } = snapshot.thread;

  if (getSelectGeneration() !== gen) {
    // A newer selection of this same thread (A → B → A) owns the buffer:
    // its load is still in flight and will replay the events when it
    // settles, so clearing here would lose them.
    if (getSelectingThreadId() !== threadId) clearWSBuffer(threadId);
    return false;
  }

  const projectId = thread.projectId;

  // Ensure project is expanded and threads are loaded
  expandProject(projectId);
  if (!isProjectListed(projectId)) {
    get().loadThreadsForProject(projectId);
  }

  const threadEvents = snapshot.events;

  // Restore context usage from localStorage when this session has none yet
  // (e.g. fresh tab), so the ring re-appears before the next WS event fires.
  restoreContextUsage(threadId, () => loadContextUsage(threadId));
  restoreAgentAccounts(loadAgentAccounts);

  seedQueueSummary(threadId, queuedCount ?? 0, queuedNextMessage);

  const hydrated = hydrateThread(get, threadId, thread, threadEvents);
  // Hydrating the full thread payload mounts the heavy message list. When
  // switching from an existing thread, defer that React commit so the
  // current content remains responsive. On a cold load there is no useful
  // content to preserve: publishing at transition priority lets sidebar
  // updates starve the first chat paint (especially while git badges are
  // arriving). Publish the initial thread urgently instead.
  // The detail view reads row fields from the collection; an opened thread
  // outside every loaded list gets its row from this detail.
  settlePreSendStateFromFetch(thread.id, thread.status);
  adoptThreadDetail(thread);
  const publishHydratedThread = () => {
    set((state) => mutations.setThreadData(state, threadId, hydrated));
  };
  if (prevActive) startTransition(publishHydratedThread);
  else publishHydratedThread();

  settleOpenedThread(set, get, ctx, thread);

  // Replay any WS events that arrived while activeThread was loading
  flushWSBuffer(threadId, get());
  return true;
}

/**
 * The urgent half of a switch: highlight the new selection at once and mount
 * the next `activeThread` at transition priority. Returns whether the previous
 * payload stays visible until the new one loads.
 */
function swapSelection(
  set: Set,
  get: Get,
  threadId: string | null,
): Pick<SwitchContext, 'prevSelectedId' | 'prevActive' | 'keepStale'> {
  // When switching to a different thread, only keep the previous payload
  // visible if the target thread's data is already fully cached (instant swap).
  // Otherwise clear it so ThreadView shows its loading spinner immediately —
  // showing the previous thread's content during a real network fetch reads
  // as "click did nothing" and is the dominant source of perceived delay.
  const prevSelectedId = get().selectedThreadId;
  const prevActive = get().activeThread;
  const isDifferentThread = !!(threadId && prevActive && prevActive.id !== threadId);
  const cacheHit = !!threadId && isThreadDataLoaded(threadId);
  const keepStale = isDifferentThread && cacheHit;

  // Split the swap into an urgent and a deferred update.
  //
  // `selectedThreadId` drives the sidebar highlight and the ThreadList
  // re-select guard — it must paint immediately so the click feels
  // instant. It's cheap (one string), so keep it synchronous/urgent.
  set({ selectedThreadId: threadId, threadLoadFailedId: null });
  notifyThreadSelected(threadId);

  // Phase boundary for a memory profiling run: the heavy MessageStream
  // subtree mounts just below. No-op unless a run is active.
  if (threadId) markMemoryPhase('thread-open');

  // `activeThread` mounts the heavy ThreadChatView → MessageStream →
  // MemoizedMessageList subtree. On a cache hit (instant swap) this is
  // the dominant INP cost on a thread switch — rendering it synchronously
  // inside the click blocks the next paint for hundreds of ms. Defer it
  // to a transition so the urgent highlight paints first and React can
  // render the message list at transition priority instead of freezing
  // the click. Zustand applies the state synchronously regardless (only
  // the React re-render is deprioritized), so the post-load eviction and
  // flushWSBuffer below still observe fresh state. The route-sync
  // invariant guard is held off by `getSelectingThreadId()` for the
  // duration of this selectThread call, so the transient
  // selectedThreadId/activeThread mismatch can't trigger a re-select.
  startTransition(() => {
    set((state) => ({
      activeThread: computeNextActiveThread(
        state,
        threadId,
        keepStale,
        prevActive,
        isDifferentThread,
      ),
    }));
  });

  // The previously-selected thread loses its implicit anchor; evict if no
  // explicit registration is holding it. Skip when the user deselected
  // back to the same thread (no-op above).
  //
  // CRITICAL: in the `keepStale` path we just set `activeThread=prevActive`
  // so the right pane keeps showing the previous thread while the new one
  // loads. Evicting `prevSelectedId` from `threadDataById` here would
  // leave `activeThread` pointing at an entry no longer in the map — the
  // back-fill subscriber would then "fix the drift" by forcing
  // `selectedThreadId` back to the previous thread, manifesting as
  // "URL changes to /B but the right pane keeps showing A". Defer the
  // eviction to the post-load path below, after `setThreadData(threadId)`
  // has repointed `activeThread` at the new thread.
  if (prevSelectedId && prevSelectedId !== threadId && !keepStale) {
    evictIfUnreferenced(get, set, prevSelectedId);
  }
  return { prevSelectedId, prevActive, keepStale };
}

/** The `selectThread` store action. */
export async function selectThreadFlow(set: Set, get: Get, threadId: string | null) {
  // Short-circuit when already deselected to avoid no-op state churn
  if (!threadId && !get().selectedThreadId && !get().activeThread) return;

  // Skip if already loading this exact thread (prevents StrictMode double-fire)
  if (threadId && threadId === getSelectingThreadId()) return;

  if (threadId) traceSelectCaller(threadId, get());

  const gen = nextSelectGeneration();
  // Allocate span / timer BEFORE claiming the in-flight slot so a synchronous
  // failure in `startSpan` (telemetry init, transport, etc.) can't leave
  // `selectingThreadId` stuck on `threadId`. If that ever happened, every
  // future `selectThread(threadId)` would short-circuit at the
  // `getSelectingThreadId()` guard above and `useRouteSync`'s invariant
  // re-select would also no-op — the exact "URL changes but the active
  // thread doesn't" symptom.
  const span = threadId
    ? startSpan('thread.select', { attributes: { 'thread.id': threadId } })
    : null;
  const startMs = Date.now();
  setSelectingThreadId(threadId);
  try {
    const swap = swapSelection(set, get, threadId);
    if (!threadId) return;

    const ctx: SwitchContext = { threadId, gen, startMs, ...swap };
    const snapshot = await loadSelectedThread(set, get, ctx);
    if (!snapshot) return;
    if (!applyLoadedThread(set, get, ctx, snapshot)) return;
    metric('thread.select.total_ms', Date.now() - startMs);
  } finally {
    span?.end();
    // Clear in-flight tracker so future selectThread calls for this thread can proceed.
    // We check getSelectGeneration() === gen to ensure we don't accidentally clear
    // the lock for a newer selectThread call to the *same* threadId that started
    // while we were waiting (e.g. A -> B -> A rapid clicks).
    if (getSelectGeneration() === gen && getSelectingThreadId() === threadId) {
      setSelectingThreadId(null);
    }
  }
}
