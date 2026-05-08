import type { ThreadEvent as DomainThreadEvent, ThreadWithMessages } from '@funny/shared';
import { assign, fromPromise, setup } from 'xstate';

import { api } from '@/lib/api';

export interface ThreadDataSnapshot {
  thread: ThreadWithMessages;
  events: DomainThreadEvent[];
}

interface ThreadDataContext {
  threadId: string;
  data: ThreadDataSnapshot | null;
  error: string | null;
}

type ThreadDataEvent =
  | { type: 'PREFETCH' }
  | { type: 'LOAD' }
  | { type: 'INVALIDATE' }
  | { type: 'RETRY' };

export const threadDataMachine = setup({
  types: {
    context: {} as ThreadDataContext,
    events: {} as ThreadDataEvent,
    input: {} as { threadId: string },
  },
  actors: {
    fetcher: fromPromise<ThreadDataSnapshot, { threadId: string }>(async ({ input, signal }) => {
      const [threadResult, eventsResult] = await Promise.all([
        api.getThread(input.threadId, 50, signal),
        api.getThreadEvents(input.threadId, signal),
      ]);
      if (threadResult.isErr()) throw threadResult.error;
      if (eventsResult.isErr()) throw eventsResult.error;
      return { thread: threadResult.value, events: eventsResult.value.events };
    }),
  },
}).createMachine({
  id: 'thread-data',
  initial: 'unloaded',
  context: ({ input }) => ({
    threadId: input.threadId,
    data: null,
    error: null,
  }),
  states: {
    unloaded: {
      on: {
        PREFETCH: 'fetching',
        LOAD: 'fetching',
      },
    },
    fetching: {
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
        INVALIDATE: {
          target: 'unloaded',
          actions: assign({ data: null, error: null }),
        },
      },
    },
    loaded: {
      on: {
        INVALIDATE: {
          target: 'unloaded',
          actions: assign({ data: null, error: null }),
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
          actions: assign({ data: null, error: null }),
        },
      },
    },
  },
});
