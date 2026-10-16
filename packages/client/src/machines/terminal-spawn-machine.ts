/**
 * Terminal spawn/restore lifecycle machine.
 *
 * Replaces the procedural soup of `useEffect` + refs + setTimeout in
 * WebTerminalTabContent. The machine encodes:
 *
 *   1. The decision tree (restored vs fresh-spawn vs wait-for-sessions-check).
 *   2. Prerequisite gating (panel visibility for new spawns; socket connection
 *      for both spawn and restore).
 *   3. Retry policy for spawn timeouts (5s, max 3 attempts) and the safety
 *      timeout for restore (3s drops the spinner if no data arrives).
 *   4. Post-connection transitions (exited / error / restart).
 *
 * Side effects (`pty:spawn`, `pty:restore` ws emits) are declared as named
 * actions and overridden at instantiation time via `.provide({actions})`.
 * Keeping the machine pure makes every transition reachable in tests without
 * touching the WebSocket layer.
 *
 * The runner-online overlay is NOT modeled here — it's an external concern
 * combined at render time, since the machine should keep ticking timers
 * regardless of runner status (so retries resume promptly when the runner
 * comes back).
 */
import { setup, assign } from 'xstate';

export const SPAWN_TIMEOUT_MS = 5000;
export const RESTORE_TIMEOUT_MS = 3000;
export const MAX_SPAWN_ATTEMPTS = 3;

interface TerminalSpawnInput {
  restored: boolean;
  wasAliveOnMount: boolean;
}

interface TerminalSpawnContext {
  restored: boolean;
  wasAliveOnMount: boolean;
  sessionsChecked: boolean;
  socketConnected: boolean;
  panelVisible: boolean;
  attempts: number;
  error: string | null;
}

type TerminalSpawnEvent =
  | { type: 'TERM_READY' }
  | { type: 'SESSIONS_CHECKED' }
  | { type: 'SET_RESTORED' }
  | { type: 'PANEL_VISIBLE'; visible: boolean }
  | { type: 'SOCKET_CONNECTED'; connected: boolean }
  | { type: 'DATA_RECEIVED' }
  | { type: 'TAB_ERROR'; error: string }
  | { type: 'TAB_EXITED' }
  | { type: 'RESTART' };

export const terminalSpawnMachine = setup({
  types: {
    context: {} as TerminalSpawnContext,
    events: {} as TerminalSpawnEvent,
    input: {} as TerminalSpawnInput,
  },
  actions: {
    // Side-effect placeholders. Components override these via .provide().
    emitSpawn: () => {},
    emitRestore: () => {},
    setSessionsChecked: assign({ sessionsChecked: true }),
    setRestored: assign({ restored: true }),
    setPanelVisible: assign({
      panelVisible: ({ event }) => (event.type === 'PANEL_VISIBLE' ? event.visible : false),
    }),
    setSocketConnected: assign({
      socketConnected: ({ event }) => (event.type === 'SOCKET_CONNECTED' ? event.connected : false),
    }),
    incrementAttempts: assign({ attempts: ({ context }) => context.attempts + 1 }),
    captureError: assign({
      error: ({ event }) => (event.type === 'TAB_ERROR' ? event.error : 'spawn failed'),
    }),
    resetForRestart: assign({
      restored: false,
      attempts: 0,
      error: null,
    }),
  },
  guards: {
    isRestored: ({ context }) => context.restored,
    canSpawnImmediately: ({ context }) => context.wasAliveOnMount || context.sessionsChecked,
    isSocketConnected: ({ context }) => context.socketConnected,
    isPanelVisible: ({ context }) => context.panelVisible,
    canRetry: ({ context }) => context.attempts + 1 < MAX_SPAWN_ATTEMPTS,
  },
  delays: {
    SPAWN_TIMEOUT: SPAWN_TIMEOUT_MS,
    RESTORE_TIMEOUT: RESTORE_TIMEOUT_MS,
  },
}).createMachine({
  id: 'terminalSpawn',
  context: ({ input }) => ({
    restored: input.restored,
    wasAliveOnMount: input.wasAliveOnMount,
    sessionsChecked: false,
    socketConnected: false,
    panelVisible: false,
    attempts: 0,
    error: null,
  }),
  initial: 'initializing',
  // Global handlers — apply in every state. TAB_ERROR jumps straight to
  // `error` (server reported a fatal problem). External signals about
  // socket / panel / sessions just update context; state transitions
  // are evaluated by states that care.
  on: {
    TAB_ERROR: { target: '.error', actions: 'captureError' },
    SOCKET_CONNECTED: { actions: 'setSocketConnected' },
    PANEL_VISIBLE: { actions: 'setPanelVisible' },
    SESSIONS_CHECKED: { actions: 'setSessionsChecked' },
    SET_RESTORED: { actions: 'setRestored' },
  },
  states: {
    initializing: {
      on: {
        TERM_READY: 'deciding',
      },
    },

    deciding: {
      always: [
        { target: 'awaitingSocketRestore', guard: 'isRestored' },
        { target: 'awaitingPanelVisible', guard: 'canSpawnImmediately' },
        { target: 'awaitingSessionsCheck' },
      ],
    },

    awaitingSessionsCheck: {
      // SESSIONS_CHECKED / SET_RESTORED are handled at the top level (set
      // context); we re-evaluate via `always`. The restore branch wins —
      // sessionsChecked + restored fire together when pty:list finds a live
      // session for this tab; we must NOT take the spawn path in that case
      // or we'd duplicate the PTY.
      always: [
        { target: 'awaitingSocketRestore', guard: 'isRestored' },
        { target: 'awaitingPanelVisible', guard: 'canSpawnImmediately' },
      ],
    },

    awaitingPanelVisible: {
      always: [{ target: 'awaitingSocketSpawn', guard: 'isPanelVisible' }],
    },

    awaitingSocketSpawn: {
      always: [{ target: 'spawning', guard: 'isSocketConnected' }],
    },

    spawning: {
      entry: 'emitSpawn',
      after: {
        SPAWN_TIMEOUT: [
          {
            target: 'awaitingSocketSpawn',
            guard: 'canRetry',
            actions: 'incrementAttempts',
          },
          { target: 'error', actions: assign({ error: 'spawn timed out' }) },
        ],
      },
      on: {
        DATA_RECEIVED: 'connected',
      },
    },

    awaitingSocketRestore: {
      always: [{ target: 'restoring', guard: 'isSocketConnected' }],
    },

    restoring: {
      entry: 'emitRestore',
      after: {
        RESTORE_TIMEOUT: 'connected',
      },
      on: {
        DATA_RECEIVED: 'connected',
      },
    },

    connected: {
      on: {
        TAB_EXITED: 'exited',
      },
    },

    exited: {
      on: {
        RESTART: { target: 'deciding', actions: 'resetForRestart' },
      },
    },

    error: {
      on: {
        RESTART: { target: 'deciding', actions: 'resetForRestart' },
      },
    },
  },
});

/**
 * Render-side phase derived from machine state + external runner status.
 * `runnerStatus` is intentionally not in the machine — see file header.
 */
export type TerminalRenderPhase =
  | 'initializing'
  | 'awaiting-runner'
  | 'awaiting-sessions'
  | 'spawning'
  | 'restoring'
  | 'connected'
  | 'exited'
  | 'error';

export function renderPhaseFromState(
  stateValue: string,
  runnerStatus: 'unknown' | 'online' | 'offline',
): TerminalRenderPhase {
  if (stateValue === 'error') return 'error';
  if (stateValue === 'exited') return 'exited';
  if (stateValue === 'connected') return 'connected';

  // Pre-connected states: a known-offline runner blocks progress.
  // 'unknown' is treated like 'online' so we don't flash an offline overlay
  // before runner:status arrives on the multiplexed socket.
  if (runnerStatus === 'offline') return 'awaiting-runner';

  if (stateValue === 'awaitingSessionsCheck') return 'awaiting-sessions';
  if (stateValue === 'restoring' || stateValue === 'awaitingSocketRestore') return 'restoring';
  if (
    stateValue === 'spawning' ||
    stateValue === 'awaitingSocketSpawn' ||
    stateValue === 'awaitingPanelVisible'
  )
    return 'spawning';
  // initializing / deciding
  return 'initializing';
}
