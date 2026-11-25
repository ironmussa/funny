import type { ThreadEvent as DomainThreadEvent, ThreadWithMessages } from '@funny/shared';
import { assign, fromPromise, setup } from 'xstate';

import { api } from '@/lib/api';
import { createClientLogger } from '@/lib/client-logger';
import { THREAD_MESSAGE_PAGE_SIZE } from '@/lib/thread-message-page';
import { loadThreadScrollFetchOptions } from '@/lib/thread-scroll-position';
import { isExternalClaudeShell } from '@/lib/thread-variant';

const log = createClientLogger('thread-data');

export interface ThreadDataSnapshot {
  thread: ThreadWithMessages;
  events: DomainThreadEvent[];
}

interface ThreadDataContext {
  threadId: string;
  data: ThreadDataSnapshot | null;
  error: string | null;
  /**
   * An INVALIDATE arrived while the fetch was in flight, so `data` may miss
   * the events behind it. The fetch is not restarted (a busy thread would
   * never finish loading): the waiting `selectThread` replays those events
   * from its WS buffer, and the next load of a stale snapshot refetches.
   */
  stale: boolean;
}

/** The thread whose data the machine loads. */
interface ThreadDataInput {
  threadId: string;
}

type ThreadDataEvent =
  | { type: 'PREFETCH' }
  | { type: 'LOAD' }
  | { type: 'INVALIDATE' }
  | { type: 'RETRY' };

// SAFETY: the `{} as T` values in `types` are xstate's type-only slots: setup() reads
// their types and never their runtime value, so the empty objects are never used as data.
export const threadDataMachine = setup({
  types: {
    context: {} as ThreadDataContext,
    events: {} as ThreadDataEvent,
    input: {} as ThreadDataInput,
  },
  actors: {
    fetcher: fromPromise<ThreadDataSnapshot, ThreadDataInput>(async ({ input, signal }) => {
      const scrollOptions = loadThreadScrollFetchOptions(input.threadId);
      const [threadResult, eventsResult] = await Promise.all([
        api.getThread(input.threadId, THREAD_MESSAGE_PAGE_SIZE, signal, scrollOptions),
        api.getThreadEvents(input.threadId, signal),
      ]);
      if (threadResult.isErr()) throw threadResult.error;
      if (eventsResult.isErr()) throw eventsResult.error;
      let thread = threadResult.value;

      // External Claude Code shells are synced without messages — hydrate the
      // transcript from the runner on first open, whatever the entry point
      // (sidebar, Activity, direct URL, Kanban). Non-fatal on failure: the
      // shell still renders and hydration retries on the next load.
      if (isExternalClaudeShell(thread) && (thread.messages ?? []).length === 0) {
        const imported = await api.importExternalClaudeSession(thread.sessionId!, {
          projectId: thread.projectId || null,
        });
        if (imported.isOk()) {
          const refetched = await api.getThread(
            input.threadId,
            THREAD_MESSAGE_PAGE_SIZE,
            signal,
            scrollOptions,
          );
          if (refetched.isOk()) thread = refetched.value;
        } else {
          log.warn('Failed to hydrate external Claude Code session', {
            threadId: input.threadId,
            sessionId: thread.sessionId,
            error: String(imported.error),
          });
        }
      }

      return {
        thread,
        events: eventsResult.value.events,
      };
    }),
  },
}).createMachine({
  id: 'thread-data',
  initial: 'unloaded',
  context: ({ input }) => ({
    threadId: input.threadId,
    data: null,
    error: null,
    stale: false,
  }),
  states: {
    unloaded: {
      on: {
        PREFETCH: 'fetching',
        LOAD: 'fetching',
      },
    },
    fetching: {
      entry: assign({ stale: false }),
      invoke: {
        src: 'fetcher',
        input: ({ context }) => ({ threadId: context.threadId }),
        onDone: {
          target: 'loaded',
          actions: assign({
            data: ({ event }) => event.output,
            error: null,
          }),
        },
        onError: {
          target: 'failed',
          actions: assign({
            data: null,
            error: ({ event }) => String(event.error ?? 'unknown error'),
          }),
        },
      },
      on: {
        // Keep the fetch running: restarting it on every event meant a thread
        // with a steady stream of events could never finish loading (#208).
        INVALIDATE: {
          actions: assign({ stale: true }),
        },
      },
    },
    loaded: {
      on: {
        INVALIDATE: {
          target: 'unloaded',
          actions: assign({ data: null, error: null, stale: false }),
        },
      },
    },
    failed: {
      on: {
        LOAD: 'fetching',
        PREFETCH: 'fetching',
        RETRY: 'fetching',
        INVALIDATE: {
          target: 'unloaded',
          actions: assign({ data: null, error: null, stale: false }),
        },
      },
    },
  },
});
