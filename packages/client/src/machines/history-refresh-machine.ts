/**
 * Commit-history auto-refresh scheduler.
 *
 * The History / Graph tabs page `git log` through the API, so nothing pushes
 * new commits to them. Instead, anything that can change history (a commit,
 * amend, push, pull, fetch, branch switch) eventually lands in the git-status
 * store, and {@link useGitHistoryAutoRefresh} turns a change in the
 * history-relevant part of that status into an `INVALIDATED` event here.
 *
 * The machine decides WHEN to reload so the component doesn't juggle refs and
 * timers:
 *
 *   fresh ──INVALIDATED──▶ debouncing ──(quiet period)──▶ stale
 *   stale ──(visible && !busy)──▶ refreshing ──done──▶ fresh
 *
 *   1. Bursts of invalidations (one commit emits several status events)
 *      collapse into a single reload: each INVALIDATED restarts the debounce.
 *   2. A hidden tab stays `stale` and reloads once on reveal, never while
 *      hidden.
 *   3. A page / manual load already in flight (`busy`) defers the reload
 *      until it finishes — the component's loader refuses concurrent loads.
 *   4. An invalidation that arrives mid-refresh is remembered and triggers
 *      one more reload afterwards, so the last change is never lost.
 *
 * The reload itself is the `refreshHistory` promise actor, provided by the
 * component via `.provide({ actors })`, which keeps the machine pure and every
 * transition testable without the API.
 */
import { assign, fromPromise, setup } from 'xstate';

export const HISTORY_REFRESH_DEBOUNCE_MS = 400;

interface HistoryRefreshContext {
  visible: boolean;
  busy: boolean;
  /** An INVALIDATED arrived while a refresh was already running. */
  invalidatedDuringRefresh: boolean;
}

type HistoryRefreshEvent =
  | { type: 'INVALIDATED' }
  | { type: 'VISIBILITY'; visible: boolean }
  | { type: 'BUSY'; busy: boolean }
  /** The git context changed; the component reloads from scratch itself. */
  | { type: 'RESET' };

export const historyRefreshMachine = setup({
  types: {
    context: {} as HistoryRefreshContext,
    events: {} as HistoryRefreshEvent,
    input: {} as { visible: boolean },
  },
  actors: {
    // Placeholder — components provide the real loader.
    refreshHistory: fromPromise<void>(async () => {}),
  },
  actions: {
    setVisible: assign({
      visible: ({ event }) => (event.type === 'VISIBILITY' ? event.visible : false),
    }),
    setBusy: assign({
      busy: ({ event }) => (event.type === 'BUSY' ? event.busy : false),
    }),
    markInvalidatedDuringRefresh: assign({ invalidatedDuringRefresh: true }),
    clearInvalidatedDuringRefresh: assign({ invalidatedDuringRefresh: false }),
  },
  guards: {
    canRefresh: ({ context }) => context.visible && !context.busy,
    invalidatedDuringRefresh: ({ context }) => context.invalidatedDuringRefresh,
  },
  delays: {
    DEBOUNCE: HISTORY_REFRESH_DEBOUNCE_MS,
  },
}).createMachine({
  id: 'historyRefresh',
  context: ({ input }) => ({
    visible: input.visible,
    busy: false,
    invalidatedDuringRefresh: false,
  }),
  initial: 'fresh',
  on: {
    VISIBILITY: { actions: 'setVisible' },
    BUSY: { actions: 'setBusy' },
    RESET: { target: '.fresh', actions: 'clearInvalidatedDuringRefresh' },
  },
  states: {
    fresh: {
      on: { INVALIDATED: 'debouncing' },
    },

    debouncing: {
      on: { INVALIDATED: { target: 'debouncing', reenter: true } },
      after: { DEBOUNCE: 'stale' },
    },

    stale: {
      // VISIBILITY / BUSY update context at the root; re-evaluated here.
      always: [{ target: 'refreshing', guard: 'canRefresh' }],
      on: { INVALIDATED: 'debouncing' },
    },

    refreshing: {
      entry: 'clearInvalidatedDuringRefresh',
      invoke: {
        src: 'refreshHistory',
        onDone: [{ target: 'stale', guard: 'invalidatedDuringRefresh' }, { target: 'fresh' }],
        // A failed reload already surfaced its own error; wait for the next
        // change (or a manual refresh) instead of retrying in a loop.
        onError: [{ target: 'stale', guard: 'invalidatedDuringRefresh' }, { target: 'fresh' }],
      },
      on: { INVALIDATED: { actions: 'markInvalidatedDuringRefresh' } },
    },
  },
});
