import { setup, transition } from 'xstate';

/**
 * Thread sandbox lifecycle state machine (change thread-sandboxes), shared by
 * the server (which enforces it on every state write) and the client (which
 * renders the states). The single source of truth for which sandbox states
 * exist and which transitions are legal.
 *
 *   provisioning ──INSTALL──▶ installing ──CONNECT──▶ connecting
 *        │ └────────────────CONNECT (template)─────────▲
 *        ▼                                             │
 *   connecting ──BOOTSTRAP──▶ bootstrapping ──READY──▶ running
 *        └───────────────────READY (no checkout)──────▲
 *
 *   running ──STOP──▶ stopping ──STOPPED──▶ stopped ──RESUME──▶ connecting
 *                        └──STOP_FAILED──▶ running (the machine is still up)
 *
 * FAIL (→ failed) and LOST (→ lost: the machine is gone or its disk expired)
 * are accepted from every non-final state. A failed or lost sandbox is only
 * replaced by provisioning a new generation, never transitioned.
 */

export type SandboxState =
  | 'provisioning'
  | 'installing'
  | 'connecting'
  | 'bootstrapping'
  | 'running'
  | 'stopping'
  | 'stopped'
  | 'failed'
  | 'lost';

export type SandboxEventType =
  | 'INSTALL'
  | 'CONNECT'
  | 'BOOTSTRAP'
  | 'READY'
  | 'STOP'
  | 'STOPPED'
  /** The provider refused to stop the machine: it is still running. */
  | 'STOP_FAILED'
  | 'RESUME'
  | 'FAIL'
  | 'LOST';

export const SANDBOX_STATES: readonly SandboxState[] = [
  'provisioning',
  'installing',
  'connecting',
  'bootstrapping',
  'running',
  'stopping',
  'stopped',
  'failed',
  'lost',
];

/** States in which the sandbox's machine exists and is being prepared or used. */
export const ACTIVE_SANDBOX_STATES: ReadonlySet<SandboxState> = new Set([
  'provisioning',
  'installing',
  'connecting',
  'bootstrapping',
  'running',
]);

const broken = { FAIL: 'failed', LOST: 'lost' } as const;

export const sandboxMachine = setup({
  types: {} as { events: { type: SandboxEventType } },
}).createMachine({
  id: 'thread-sandbox',
  initial: 'provisioning',
  states: {
    provisioning: { on: { INSTALL: 'installing', CONNECT: 'connecting', ...broken } },
    installing: { on: { CONNECT: 'connecting', ...broken } },
    connecting: { on: { BOOTSTRAP: 'bootstrapping', READY: 'running', ...broken } },
    bootstrapping: { on: { READY: 'running', ...broken } },
    running: { on: { STOP: 'stopping', ...broken } },
    stopping: { on: { STOPPED: 'stopped', STOP_FAILED: 'running', ...broken } },
    stopped: { on: { RESUME: 'connecting', ...broken } },
    failed: { type: 'final' },
    lost: { type: 'final' },
  },
});

/** The state `event` leads to from `from`, or null when the transition is illegal. */
export function nextSandboxState(from: SandboxState, event: SandboxEventType): SandboxState | null {
  const snapshot = sandboxMachine.resolveState({ value: from, context: undefined });
  if (!snapshot.can({ type: event })) return null;
  const [next] = transition(sandboxMachine, snapshot, { type: event });
  return next.value as SandboxState;
}

/** Every state an event may be applied from, with the (single) state it leads to. */
export function sandboxTransitionsFor(event: SandboxEventType): {
  from: SandboxState[];
  to: SandboxState;
} | null {
  let to: SandboxState | null = null;
  const from: SandboxState[] = [];
  for (const state of SANDBOX_STATES) {
    const next = nextSandboxState(state, event);
    if (next) {
      from.push(state);
      to = next;
    }
  }
  return to ? { from, to } : null;
}
